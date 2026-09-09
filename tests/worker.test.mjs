import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { archiveHandoff, git, githubRepository, inside, readHandoffSnapshot, recoveryCheckpoint, requestWorkerApi, restoreCheckpoint, work } from '../bin/worker.mjs';
import { executionBinding, runClient } from '../bin/client-adapters.mjs';
const response = body => new Response(JSON.stringify(body), { status: 200 });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'workforce-test-')), repo = join(root, 'repo'), state = join(root, 'state');
  mkdirSync(repo); mkdirSync(state); git(repo, ['init', '-b', 'main']); git(repo, ['config', 'core.autocrlf', 'false']); git(repo, ['config', 'user.name', 'Test']); git(repo, ['config', 'user.email', 'test@example.test']);
  writeFileSync(join(repo, 'app.txt'), 'original\n'); git(repo, ['add', '.']); git(repo, ['commit', '-m', 'base']);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, repo, state, sha: git(repo, ['rev-parse', 'HEAD']).trim() };
}
test('recovery preserves tracked and untracked source, excluding local secrets', t => {
  const f = fixture(t); writeFileSync(join(f.repo, 'app.txt'), 'changed\n'); writeFileSync(join(f.repo, 'new.txt'), 'new\n'); writeFileSync(join(f.repo, '.env.local'), 'SECRET=never-upload');
  const checkpoint = recoveryCheckpoint(f.repo, f.sha, f.state), patch = Buffer.from(checkpoint.patch, 'base64').toString();
  assert.match(patch, /changed/); assert.match(patch, /new.txt/); assert.doesNotMatch(patch, /SECRET/);
  const restored = join(f.root, 'restored'); git(f.repo, ['worktree', 'add', '--detach', restored, f.sha]); restoreCheckpoint(restored, checkpoint);
  assert.equal(readFileSync(join(restored, 'app.txt'), 'utf8'), 'changed\n'); assert.equal(readFileSync(join(restored, 'new.txt'), 'utf8'), 'new\n'); assert.equal(existsSync(join(restored, '.env.local')), false);
  assert.throws(() => restoreCheckpoint(restored, { ...checkpoint, digest: '0'.repeat(64) }), /corrupt/);
});
test('worker validates origin and keeps filesystem paths inside its state', () => {
  assert.equal(githubRepository('git@github.com:Example/Project.git'), 'example/project'); assert.equal(githubRepository('https://github.com/Example/Project'), 'example/project');
  assert.throws(() => githubRepository('https://attacker.test/example/project'), /GitHub origin/); assert.equal(inside('/work', '/work/../secrets'), false); assert.equal(inside('/work', '/work'), false);
});
test('idle worker never launches a model and releases its lock', async t => {
  const f = fixture(t); git(f.repo, ['remote', 'add', 'origin', 'https://github.com/fixture/repo.git']); let turns = 0;
  await work({ host: 'http://localhost', token: 'test', repo: f.repo, state: f.state, write: true, model: 'test-model', capability: { client: 'codex', version: 'test' }, once: true, fetch: async () => response({ job: null }), runClient: async () => { turns++; } });
  assert.equal(turns, 0); assert.equal(existsSync(join(f.state, 'worker.lock')), false);
});
test('corrupt state does not strand a worker lock', async t => {
  const f = fixture(t); git(f.repo, ['remote', 'add', 'origin', 'https://github.com/fixture/repo.git']); writeFileSync(join(f.state, 'state.json'), '{bad');
  await assert.rejects(work({ host: 'http://localhost', token: 'test', repo: f.repo, state: f.state, write: true, model: 'test-model', capability: { client: 'codex', version: 'test' }, once: true }));
  assert.equal(existsSync(join(f.state, 'worker.lock')), false);
});

test('corrupt activity state releases the worker lock and a repaired state can restart', async t => {
  const f = fixture(t); git(f.repo, ['remote', 'add', 'origin', 'https://github.com/fixture/repo.git']); writeFileSync(join(f.state, 'activity.json'), '{bad');
  const options = { host: 'http://localhost', token: 'test', repo: f.repo, state: f.state, write: true, model: 'test-model', capability: { client: 'codex', version: 'test' }, once: true, fetch: async () => response({ job: null }) };
  await assert.rejects(work(options));
  assert.equal(existsSync(join(f.state, 'worker.lock')), false);
  unlinkSync(join(f.state, 'activity.json'));
  await work(options);
  assert.equal(existsSync(join(f.state, 'worker.lock')), false);
});

const handoff = { outcome: 'complete', summary: 'Review recorded', evidence: ['Read the current diff'], nextSteps: [] };
function executableFixture(t, finishSucceeds = true) {
  const f = fixture(t); git(f.repo, ['remote', 'add', 'origin', 'https://github.com/fixture/repo.git']); git(f.repo, ['update-ref', 'refs/remotes/origin/main', f.sha]);
  const sent = [], job = { id: 'coord-agent', kind: 'coordination', fence: 1, maxMinutes: 1, maxCostUsd: 2, assignment: { kind: 'review', instruction: 'Review' } };
  const options = { host: 'http://localhost', token: 'test', repo: f.repo, state: f.state, write: true, model: 'test-model', capability: { client: 'codex', version: 'test' }, once: true, log: () => {},
    git: (cwd, args) => args[0] === 'fetch' ? '' : git(cwd, args),
    fetch: async (url, request) => {
      const data = JSON.parse(request.body); sent.push({ url, data });
      if (data.action === 'claim') return response({ job, repository: { owner: 'fixture', repo: 'repo', base: 'main' } });
      if (data.action === 'finish') return finishSucceeds ? response({ recorded: true }) : new Response('{}', { status: 503 });
      return response({});
    },
    runClient: async (_client, _prompt, args) => { assert.equal(args.env.AGENT_COLLAB_TOKEN, 'test'); args.onUsage({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3 } }); writeFileSync(join(args.cwd, '.ehgi-handoff.json'), JSON.stringify(handoff)); return { completed: true }; },
  };
  return { ...f, sent, options, cwd: join(f.state, 'worktrees', 'coord-agent-1'), archive: join(f.state, 'handoffs', 'worker-coord-agent-1.json') };
}

test('coordination usage identifies its job reservation and acknowledged handoffs are archived before cleanup', async t => {
  const f = executableFixture(t); await work(f.options);
  const usage = f.sent.filter(item => item.url.endsWith('/api/usage/report'));
  assert.equal(usage.length, 1); assert.equal(usage[0].data.task_id, 'coord-agent'); assert.equal(usage[0].data.phase, 'coordination');
  assert.equal(usage[0].data.event_id, 'worker-coord-agent-1-0');
  const saved = JSON.parse(readFileSync(f.archive, 'utf8'));
  assert.deepEqual(saved.handoff, handoff); assert.match(saved.digest, /^[a-f0-9]{64}$/);
  assert.equal(existsSync(join(f.cwd, '.ehgi-handoff.json')), false);
  assert.equal(git(f.cwd, ['status', '--porcelain']).trim(), '');
});

test('unacknowledged handoffs stay in the worktree for recovery', async t => {
  const f = executableFixture(t, false); await work(f.options);
  assert.equal(existsSync(f.archive), false);
  assert.equal(readHandoffSnapshot(f.cwd).handoff.summary, handoff.summary);
  assert.equal(f.sent.filter(item => item.data.action === 'finish').length, 1, 'an uncertain success is never replaced by a failed finish');
});

test('a UTF-8 BOM handoff is acknowledged while its original bytes remain bound to the archive', async t => {
  const f = executableFixture(t), bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(handoff))]);
  await work({ ...f.options, runClient: async (client, prompt, args) => {
    await f.options.runClient(client, prompt, args);
    writeFileSync(join(args.cwd, '.ehgi-handoff.json'), bytes);
  } });
  assert.deepEqual(f.sent.find(item => item.data.action === 'finish')?.data.handoff, handoff);
  const archive = JSON.parse(readFileSync(f.archive, 'utf8'));
  assert.deepEqual(archive.handoff, handoff);
  assert.equal(archive.digest, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(existsSync(join(f.cwd, '.ehgi-handoff.json')), false);
  writeFileSync(join(f.cwd, '.ehgi-handoff.json'), bytes);
  const snapshot = readHandoffSnapshot(f.cwd);
  writeFileSync(join(f.cwd, '.ehgi-handoff.json'), bytes.subarray(3));
  assert.throws(() => archiveHandoff(f.cwd, f.state, 'bom-removed', snapshot), /changed after acknowledgement/);
  assert.equal(existsSync(join(f.cwd, '.ehgi-handoff.json')), true);
});

test('handoff BOM tolerance does not permit a second BOM or evade the byte-size limit', t => {
  const f = fixture(t), path = join(f.repo, '.ehgi-handoff.json'), bom = Buffer.from([0xef, 0xbb, 0xbf]);
  writeFileSync(path, Buffer.concat([bom, bom, Buffer.from(JSON.stringify(handoff))]));
  assert.throws(() => readHandoffSnapshot(f.repo), SyntaxError);
  writeFileSync(path, Buffer.concat([bom, Buffer.alloc(11998, 0x20)]));
  assert.throws(() => readHandoffSnapshot(f.repo), /exceeds 12 KB/);
});

function blockedTaskFixture(t, reason = 'Task blocked pending new information') {
  const f = executableFixture(t), blocked = { outcome: 'blocked', summary: 'Asked the host for the required behavior', evidence: ['Posted a question in the task thread'], nextSteps: ['Wait for the answer before continuing'] };
  let clientReturned = false;
  const options = { ...f.options,
    fetch: async (url, request) => {
      const data = JSON.parse(request.body), result = await f.options.fetch(url, request);
      if (data.action === 'claim') {
        const body = await result.json();
        return response({ ...body, job: { ...body.job, kind: 'implementation', task: { id: 'coord-agent', number: 1, leaseVersion: 7, branch: 'agent/publication' } } });
      }
      if (data.action === 'heartbeat' && clientReturned) return response({ stop: true, reason, leaseVersion: 8 });
      return result;
    },
    runClient: async (client, prompt, args) => {
      await f.options.runClient(client, prompt, args);
      writeFileSync(join(args.cwd, '.ehgi-handoff.json'), JSON.stringify(blocked));
      clientReturned = true;
    },
  };
  return { ...f, options, blocked };
}

test('a successful client preserves its blocked handoff after the hub releases the task', async t => {
  const f = blockedTaskFixture(t); await work(f.options);
  const finish = f.sent.find(item => item.data.action === 'finish')?.data;
  assert.deepEqual(finish.handoff, f.blocked, 'the public blocked transition must not discard the completed client handoff');
  assert.deepEqual(JSON.parse(readFileSync(f.archive, 'utf8')).handoff, f.blocked);
  assert.equal(JSON.parse(readFileSync(join(f.state, 'state.json'), 'utf8')).active, null);
});

for (const reason of ['Operator requested agent stop', 'Task lease replaced', 'Job cost limit reached']) test(`a blocked handoff cannot override ${reason}`, async t => {
  const f = blockedTaskFixture(t, reason); await work(f.options);
  const finish = f.sent.find(item => item.data.action === 'finish')?.data;
  assert.equal(finish.succeeded, false);
  assert.equal(finish.handoff, undefined);
  assert.equal(existsSync(f.archive), false);
  assert.deepEqual(readHandoffSnapshot(f.cwd).handoff, f.blocked);
});

test('the acknowledged block does not accept a different handoff outcome', async t => {
  const f = blockedTaskFixture(t);
  await work({ ...f.options, runClient: async (client, prompt, args) => {
    await f.options.runClient(client, prompt, args);
    writeFileSync(join(args.cwd, '.ehgi-handoff.json'), JSON.stringify({ ...f.blocked, outcome: 'more_work' }));
  } });
  assert.equal(f.sent.find(item => item.data.action === 'finish')?.data.succeeded, false);
  assert.equal(existsSync(f.archive), false);
});

test('worker retries safe delivery with stable usage ids and clears only acknowledged reports', async t => {
  const f = executableFixture(t), sent = [], waits = [];
  let failed = false;
  await work({ ...f.options, wait: async delay => { waits.push(delay); }, fetch: async (url, request) => {
    assert.equal(request.redirect, 'error');
    if (url.endsWith('/api/usage/report')) {
      sent.push(JSON.parse(request.body));
      if (!failed) { failed = true; return new Response('{}', { status: 503 }); }
    }
    return f.options.fetch(url, request);
  }, runClient: async (client, prompt, args) => {
    await f.options.runClient(client, prompt, args);
    args.onUsage({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 5 } });
  } });
  assert.deepEqual(waits, [1000]);
  assert.deepEqual(sent.map(item => item.event_id), ['worker-coord-agent-1-0', 'worker-coord-agent-1-0', 'worker-coord-agent-1-1']);
  assert.deepEqual(sent[0], sent[1]);
  assert.deepEqual(JSON.parse(readFileSync(join(f.state, 'state.json'), 'utf8')).usage, []);
});

test('final provider usage is delivered after Stop without starting another paid turn', async t => {
  const f = executableFixture(t), stop = new AbortController(); let turns = 0;
  await work({ ...f.options, once: false, signal: stop.signal, runClient: async (_client, prompt, args) => {
    turns++; assert.match(prompt, /Before the final MCP done or blocked transition, write/);
    stop.abort();
    args.onUsage({ type: 'turn.completed', usage: { input_tokens: 13, output_tokens: 4 } });
    throw Object.assign(Error('cancelled'), { name: 'AbortError', retryable: false });
  } });
  assert.equal(turns, 1);
  assert.equal(f.sent.filter(item => item.data.action === 'claim').length, 1);
  const reports = f.sent.filter(item => item.url.endsWith('/api/usage/report'));
  assert.equal(reports.length, 1); assert.equal(reports[0].data.input_tokens, 13);
  assert.deepEqual(JSON.parse(readFileSync(join(f.state, 'state.json'), 'utf8')).usage, []);
});

test('the final usage drain is bounded and preserves undelivered reports after Stop', async t => {
  const f = executableFixture(t), stop = new AbortController(), sent = [], originalTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => originalTimeout(callback, ms === 5000 ? 50 : ms, ...args));
  await work({ ...f.options, once: false, signal: stop.signal, fetch: async (url, request) => {
    if (!url.endsWith('/api/usage/report')) return f.options.fetch(url, request);
    sent.push(JSON.parse(request.body));
    await new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(Object.assign(Error('aborted'), { name: 'AbortError' })), { once: true });
    });
  }, runClient: async (_client, _prompt, args) => {
    stop.abort(); args.onUsage({ type: 'turn.completed', usage: { input_tokens: 13, output_tokens: 4 } });
    throw Object.assign(Error('cancelled'), { name: 'AbortError', retryable: false });
  } });
  const saved = JSON.parse(readFileSync(join(f.state, 'state.json'), 'utf8'));
  assert.equal(sent.length, 1); assert.deepEqual(saved.usage, sent);
  assert.equal(f.sent.filter(item => item.data.action === 'claim').length, 1);
  assert.equal(existsSync(join(f.state, 'worker.lock')), false);
});

for (const mode of ['baseline', 'recovery', 'no-reports']) test(`missing ${mode} usage durably pauses paid work before another claim`, async t => {
  const f = executableFixture(t), logs = [];
  await work({ ...f.options, once: false, log: message => logs.push(message), runClient: async (_client, _prompt, args) => {
    if (mode === 'baseline') throw Object.assign(Error('PRIVATE file path'), { code: 'CODEX_USAGE_UNAVAILABLE' });
    if (mode === 'recovery') {
      args.onUsage({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3 } });
      throw Object.assign(Error('cancelled'), { name: 'AbortError', usageRecoveryError: 'PRIVATE diagnostic', sessionId: '0198f460-c7e7-7000-8000-000000000001' });
    }
    writeFileSync(join(args.cwd, '.ehgi-handoff.json'), JSON.stringify(handoff));
  } });
  assert.equal(f.sent.filter(item => item.data.action === 'claim').length, 1);
  const saved = JSON.parse(readFileSync(join(f.state, 'state.json'), 'utf8'));
  assert.equal(saved.usageAttention.jobId, 'coord-agent');
  assert(!JSON.stringify(saved.usageAttention).includes('PRIVATE'));
  if (mode === 'recovery') {
    const usageIndex = f.sent.findIndex(item => item.url.endsWith('/api/usage/report'));
    assert(usageIndex !== -1 && usageIndex < f.sent.findIndex(item => item.data.action === 'finish'));
    assert.deepEqual(saved.usage, []);
    assert.equal(saved.usageAttention.sessionId, '0198f460-c7e7-7000-8000-000000000001');
    assert(!logs.join('\n').includes('PRIVATE'));
  }
  await assert.rejects(work({ ...f.options, fetch: async () => assert.fail('paused worker must not register or claim'), runClient: async () => assert.fail('paused worker must not launch a client') }), error => error.code === 'WORKER_USAGE_ATTENTION' && error.retryable === false);
  assert.equal(existsSync(join(f.state, 'worker.lock')), false);
});

test('safe worker requests retry network and transient status failures with a bounded backoff', async () => {
  for (const status of [null, 408, 429, 503]) {
    let attempts = 0; const waits = [];
    await assert.rejects(requestWorkerApi({ host: 'http://localhost', token: 'test', wait: async delay => { waits.push(delay); }, fetch: async () => {
      attempts++;
      if (status === null) throw Object.assign(new Error('socket failure'), { code: 'ECONNRESET' });
      return new Response('{}', { status });
    } }, '/api/agent/worker', { action: 'heartbeat', fence: 3 }), error => error.retryable === true);
    assert.equal(attempts, 3); assert.deepEqual(waits, [1000, 2000]);
  }
});

test('claim and finish errors are not transparently retried', async () => {
  for (const action of ['claim', 'finish']) {
    let attempts = 0;
    await assert.rejects(requestWorkerApi({ host: 'http://localhost', token: 'test', fetch: async () => { attempts++; return new Response('{}', { status: 503 }); } }, '/api/agent/worker', { action }), error => error.retryable === true);
    assert.equal(attempts, 1);
  }
});

test('authorization, stale-fence, and redirect failures are final and never retried', async () => {
  for (const status of [401, 403, 409]) {
    let attempts = 0;
    await assert.rejects(requestWorkerApi({ host: 'http://localhost', token: 'test', fetch: async () => { attempts++; return new Response('not json', { status }); } }, '/api/agent/worker', { action: 'register' }), error => error.retryable === false && error.status === status);
    assert.equal(attempts, 1);
  }
  let attempts = 0;
  await assert.rejects(requestWorkerApi({ host: 'http://localhost', token: 'test', fetch: async (_url, options) => {
    attempts++; assert.equal(options.redirect, 'error');
    throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
  } }, '/api/agent/worker', { action: 'register' }), error => error.retryable === false);
  assert.equal(attempts, 1);
});

test('Stop interrupts pending retry delays and prevents another request', async () => {
  const controller = new AbortController(); let attempts = 0;
  const started = Date.now();
  await assert.rejects(requestWorkerApi({ host: 'http://localhost', token: 'test', signal: controller.signal, fetch: async () => {
    attempts++; setTimeout(() => controller.abort(), 20); return new Response('{}', { status: 503 });
  } }, '/api/agent/worker', { action: 'register' }), error => error.name === 'AbortError' && error.retryable === false);
  assert.equal(attempts, 1); assert(Date.now() - started < 900);
});

for (const [flag, outcome] of [['requiresAuthentication', 'needs_auth'], ['requiresApproval', 'needs_approval']]) test(`typed ${flag} produces a sanitized blocked handoff`, async t => {
  const f = executableFixture(t);
  await work({ ...f.options, runClient: async () => { throw Object.assign(new Error('PRIVATE provider diagnostic'), { [flag]: true }); } });
  const finish = f.sent.find(item => item.data.action === 'finish')?.data;
  assert.equal(finish.succeeded, false); assert.equal(finish.handoff.outcome, outcome);
  assert(!JSON.stringify(finish).includes('PRIVATE'));
});

test('a terminal client permission or authentication failure ends a continuous worker before its next claim', async t => {
  for (const flag of ['requiresAuthentication', 'requiresApproval']) {
    const f = executableFixture(t);
    await work({ ...f.options, once: false, runClient: async () => { throw Object.assign(Error('denied'), { [flag]: true }); } });
    assert.equal(f.sent.filter(item => item.data.action === 'claim').length, 1);
    assert.equal(existsSync(join(f.state, 'worker.lock')), false);
  }
});

test('worker binding guards run before network calls and forward the verified profile into the actual invocation', async t => {
  const f = executableFixture(t), home = join(f.root, 'codex-home'); mkdirSync(home);
  const capability = { ...f.options.capability, executable: process.execPath, profiles: true };
  await work({ ...f.options, capability, fetch: async () => response({ job: null }) });
  writeFileSync(join(home, 'config.toml'), 'model = "base"\n');
  const profilePath = join(home, 'ehgi.config.toml'), content = 'approval_policy = "on-request"\n'; writeFileSync(profilePath, content);
  const options = { ...f.options, capability, profile: 'ehgi', env: { ...process.env, CODEX_HOME: home } };
  const path = join(f.state, 'state.json'), saved = JSON.parse(readFileSync(path, 'utf8'));
  saved.enrollment = { verifiedAt: new Date().toISOString(), execution: executionBinding(capability, options) }; writeFileSync(path, JSON.stringify(saved));
  writeFileSync(profilePath, 'approval_policy = "never"\n');
  await assert.rejects(work({ ...options, fetch: async () => assert.fail('changed binding must stop before HTTP') }), error => error.code === 'ENROLLMENT_CHANGED');
  assert.equal(existsSync(join(f.state, 'worker.lock')), false);
  writeFileSync(profilePath, content);
  let turns = 0;
  await work({ ...options, runClient: async (client, prompt, args) => {
    turns++; assert.equal(args.profile, 'ehgi'); assert.equal(args.env.CODEX_HOME, home);
    assert.equal(JSON.parse(readFileSync(join(f.state, 'worker.lock'), 'utf8')).phase, 'client_active');
    return f.options.runClient(client, prompt, args);
  } });
  assert.equal(turns, 1);
});

for (const moment of ['after-claim', 'during-fetch', 'before-client']) test(`an actual origin change ${moment} stops the continuous worker before any paid run`, async t => {
  const f = executableFixture(t); let turns = 0, heartbeats = 0;
  const change = () => git(f.repo, ['remote', 'set-url', 'origin', 'https://github.com/unrelated/repository.git']);
  await work({ ...f.options, once: false,
    git: (cwd, args) => { if (moment === 'during-fetch' && args[0] === 'fetch') change(); return f.options.git(cwd, args); },
    fetch: async (url, options) => {
      const data = JSON.parse(options.body), result = await f.options.fetch(url, options);
      if (moment === 'after-claim' && data.action === 'claim') change();
      if (data.action === 'heartbeat' && ++heartbeats === 3 && moment === 'before-client') change();
      return result;
    }, runClient: async () => { turns++; assert.fail('changed origin must never reach a model'); },
  });
  assert.equal(turns, 0); assert.equal(f.sent.filter(item => item.data.action === 'claim').length, 1);
  const finish = f.sent.find(item => item.data.action === 'finish')?.data;
  assert.equal(finish.succeeded, false); assert.match(finish.note, /origin changed/);
  assert.equal(existsSync(join(f.state, 'worker.lock')), false);
});

test('handoff cleanup preserves changed or tracked files and rejects paths outside worker ownership', t => {
  const f = fixture(t), cwd = join(f.state, 'worktrees', 'owned'); mkdirSync(join(f.state, 'worktrees'));
  git(f.repo, ['worktree', 'add', '--detach', cwd, f.sha]);
  const file = join(cwd, '.ehgi-handoff.json'); writeFileSync(file, JSON.stringify(handoff));
  const snapshot = readHandoffSnapshot(cwd);
  writeFileSync(file, JSON.stringify({ ...handoff, summary: 'Changed after acknowledgement' }));
  assert.throws(() => archiveHandoff(cwd, f.state, 'changed', snapshot), /changed after acknowledgement/);
  assert.equal(existsSync(file), true);
  assert.deepEqual(JSON.parse(readFileSync(join(f.state, 'handoffs', 'changed.json'))).handoff, handoff);
  git(cwd, ['add', '.ehgi-handoff.json']);
  assert.throws(() => archiveHandoff(cwd, f.state, 'tracked', readHandoffSnapshot(cwd)), /committed or staged/);
  assert.equal(existsSync(file), true);
  assert.throws(() => archiveHandoff(f.repo, f.state, 'outside', snapshot), /belong to this worker/);
});

test('handoff reads reject symbolic links without reading their targets', t => {
  const f = fixture(t), target = join(f.root, 'external.json'), path = join(f.repo, '.ehgi-handoff.json');
  writeFileSync(target, JSON.stringify(handoff));
  try { symlinkSync(target, path, 'file'); }
  catch (error) { if (error.code !== 'EPERM') throw error; symlinkSync(f.state, path, 'junction'); }
  assert.throws(() => readHandoffSnapshot(f.repo), /regular file/);
  assert.equal(readFileSync(target, 'utf8'), JSON.stringify(handoff));
});
test('wrong repository is blocked before fetch or model execution', async t => {
  const f = fixture(t); git(f.repo, ['remote', 'add', 'origin', 'https://github.com/fixture/repo.git']); let finish, turns = 0;
  await work({ host: 'http://localhost', token: 'test', repo: f.repo, state: f.state, write: true, model: 'test-model', capability: { client: 'codex', version: 'test' }, once: true, log: () => {}, fetch: async (_url, options) => { const body = JSON.parse(options.body); if (body.action === 'finish') finish = body; return response(body.action === 'claim' ? { job: { id: 'task', fence: 1 }, repository: { owner: 'other', repo: 'repository' } } : {}); }, runClient: async () => { turns++; } });
  assert.equal(turns, 0); assert.equal(finish.succeeded, false); assert.match(finish.note, /does not match/);
});

test('worker deduplicates provider replay while preserving distinct Codex turns and HTTP retry IDs', async t => {
  const f = executableFixture(t), delivered = []; let failed = false;
  await work({ ...f.options, wait: async () => {}, fetch: async (url, request) => {
    if (url.endsWith('/api/usage/report')) {
      delivered.push(JSON.parse(request.body));
      if (!failed) { failed = true; return new Response('{}', { status: 503 }); }
    }
    return f.options.fetch(url, request);
  }, runClient: async (_client, _prompt, args) => {
    const report = { type: 'turn.completed', event_id: 'same-provider-turn', usage: { input_tokens: 10, output_tokens: 3 } };
    args.onUsage(report); args.onUsage(report);
    args.onUsage({ ...report, event_id: undefined }); args.onUsage({ ...report, event_id: undefined });
    writeFileSync(join(args.cwd, '.ehgi-handoff.json'), JSON.stringify(handoff));
    return { completed: true };
  } });
  assert.deepEqual(delivered.map(report => report.event_id), ['worker-coord-agent-1-0', 'worker-coord-agent-1-0', 'worker-coord-agent-1-1', 'worker-coord-agent-1-2']);
  assert.deepEqual(delivered[0], delivered[1], 'lost delivery acknowledgements reuse the original report');
  assert.equal(f.sent.filter(item => item.url.endsWith('/api/usage/report')).length, 3);
  assert.deepEqual(JSON.parse(readFileSync(join(f.state, 'state.json'), 'utf8')).usage, []);
});

test('live cumulative usage is delivered before a serialized budget pulse can stop the client', { timeout: 5000 }, async t => {
  const f = executableFixture(t), delivered = []; let active = 0, peak = 0, clientRunning = false, stoppedWhileRunning = false;
  await work({ ...f.options, fetch: async (url, request) => {
    const packet = JSON.parse(request.body);
    if (url.endsWith('/api/usage/report')) {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 20));
      delivered.push(packet); active--;
    }
    if (packet.action === 'heartbeat' && clientRunning) {
      assert.equal(active, 0); assert.equal(delivered.length, 1);
      return response({ stop: true, reason: 'Job cost limit reached' });
    }
    return f.options.fetch(url, request);
  }, runClient: async (_client, _prompt, args) => {
    clientRunning = true;
    const event = { type: 'ehgi.codex_usage_snapshot', event_id: 'first', usage: { input_tokens: 10, output_tokens: 3, cached_input_tokens: 5 } };
    args.onUsage(event); args.onUsage(event);
    args.onUsage({ ...event, event_id: 'second', usage: { input_tokens: 20, output_tokens: 6, cached_input_tokens: 10 } });
    await new Promise(resolve => args.signal.addEventListener('abort', resolve, { once: true }));
    stoppedWhileRunning = true; clientRunning = false;
    throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
  } });
  assert.equal(stoppedWhileRunning, true); assert.equal(peak, 1);
  assert.deepEqual(delivered.map(report => [report.cumulative, report.input_tokens, report.session_id]), [[true, 10, 'worker-coord-agent-1'], [true, 20, 'worker-coord-agent-1']]);
  assert.equal(new Set(delivered.map(report => report.event_id)).size, 2);
  assert.deepEqual(JSON.parse(readFileSync(join(f.state, 'state.json'))).usage, []);
});

test('a continuing usage producer cannot postpone authority Stop until the outbox empties', { timeout: 5000 }, async t => {
  const f = executableFixture(t); let produce, running = false, generated = 0, delivered = 0, deliveredAtStop;
  await work({ ...f.options, fetch: async (url, request) => {
    const packet = JSON.parse(request.body);
    if (url.endsWith('/api/usage/report')) {
      await new Promise(resolve => setTimeout(resolve, 5)); delivered++;
      if (running && generated < 20) produce();
    }
    if (packet.action === 'heartbeat' && running) {
      deliveredAtStop = delivered;
      assert(JSON.parse(readFileSync(join(f.state, 'state.json'))).usage.length > 0, 'producer still has pending accounting when authority is checked');
      return response({ stop: true, reason: 'Operator requested agent stop' });
    }
    return f.options.fetch(url, request);
  }, runClient: async (_client, _prompt, args) => {
    running = true;
    produce = () => { generated++; args.onUsage({ type: 'ehgi.codex_usage_snapshot', event_id: `snapshot-${generated}`, usage: { input_tokens: generated * 10, output_tokens: generated * 2, cached_input_tokens: generated * 5 } }); };
    produce(); await new Promise(resolve => args.signal.addEventListener('abort', resolve, { once: true }));
    running = false; throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
  } });
  assert.equal(deliveredAtStop, 1); assert.equal(generated, 2); assert.equal(delivered, generated);
  assert.deepEqual(JSON.parse(readFileSync(join(f.state, 'state.json'))).usage, []);
});

function finalizingChildFixture(t, { reason = 'Task completed', expire = false, restrictive } = {}) {
  const f = executableFixture(t), output = { ...handoff, outcome: reason === 'Task completed' ? 'complete' : 'blocked' };
  const executable = join(f.root, 'finalizing-child.cjs');
  writeFileSync(executable, `const {writeFileSync}=require('node:fs');
    console.log(JSON.stringify({type:'thread.started',thread_id:'01a08354-4c9d-7c90-becb-39b58bc8ca35'}));
    ${expire || restrictive ? 'setInterval(()=>{},1000);' : `setTimeout(()=>{writeFileSync('.ehgi-handoff.json',${JSON.stringify(JSON.stringify(output))});console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:3}}));},700);`}`);
  const originalInterval = globalThis.setInterval, originalTimeout = globalThis.setTimeout;
  let started = false, terminalPulses = 0, graceTimers = 0, cancelled = false;
  // Compress only worker heartbeat/grace timers; the child is a real Node
  // process with its own real clock, filesystem handoff and structured output.
  t.mock.method(globalThis, 'setInterval', (callback, ms, ...args) => originalInterval(callback, ms === 20000 ? 80 : ms, ...args));
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => { if (ms === 30000) graceTimers++; return originalTimeout(callback, expire && ms === 30000 ? 250 : ms, ...args); });
  const options = { ...f.options,
    fetch: async (url, request) => {
      const data = JSON.parse(request.body), result = await f.options.fetch(url, request);
      if (data.action === 'claim') {
        const body = await result.json();
        return response({ ...body, job: { ...body.job, kind: 'implementation', task: { id: 'coord-agent', number: 1, leaseVersion: 7, branch: 'agent/publication' } } });
      }
      if (data.action === 'heartbeat' && started) {
        terminalPulses++;
        if (restrictive && terminalPulses > 1) return typeof restrictive === 'number' ? new Response(JSON.stringify({ error: 'Execution authorization or fence changed' }), { status: restrictive }) : response({ stop: true, reason: restrictive });
        return response({ stop: true, reason, leaseVersion: reason === 'Task completed' ? 7 : 8 });
      }
      return result;
    },
    runClient: async (_capability, prompt, args) => {
      started = true;
      args.signal.addEventListener('abort', () => { cancelled = true; });
      return runClient({ client: 'codex', executable: process.execPath, prefixArgs: [executable] }, prompt, { ...args, env: { ...args.env, CODEX_HOME: join(f.root, 'empty-client-home') } });
    },
  };
  return { ...f, options, output, observed: () => ({ terminalPulses, graceTimers, cancelled }) };
}

for (const reason of ['Task completed', 'Task blocked pending new information']) test(`a real child can emit its final handoff and usage after ${reason}`, async t => {
  const f = finalizingChildFixture(t, { reason }); await work(f.options);
  assert.deepEqual(f.sent.find(item => item.data.action === 'finish')?.data.handoff, f.output);
  assert.ok(f.observed().terminalPulses >= 1); assert.equal(f.observed().graceTimers, 1);
  assert.equal(f.sent.filter(item => item.url.endsWith('/api/usage/report')).length, 1);
  assert.deepEqual(JSON.parse(readFileSync(f.archive, 'utf8')).handoff, f.output);
});

test('repeated terminal heartbeats cannot extend a real child finalization deadline', async t => {
  const f = finalizingChildFixture(t, { expire: true }); await work(f.options);
  assert.ok(f.observed().terminalPulses >= 2); assert.equal(f.observed().graceTimers, 1); assert.equal(f.observed().cancelled, true);
  const finish = f.sent.find(item => item.data.action === 'finish')?.data;
  assert.equal(finish.succeeded, false); assert.match(finish.note, /30-second grace period/); assert.equal(existsSync(f.archive), false);
});

for (const restrictive of ['Operator requested agent stop', 'Job cost limit reached', 401, 409]) test(`finalization grace immediately yields to ${restrictive}`, async t => {
  const f = finalizingChildFixture(t, { restrictive }); await work(f.options);
  assert.equal(f.observed().graceTimers, 1); assert.equal(f.observed().cancelled, true);
  const finish = f.sent.find(item => item.data.action === 'finish')?.data;
  assert.equal(finish.succeeded, false); assert.equal(finish.handoff, undefined); assert.equal(existsSync(f.archive), false);
  assert.equal(finish.note, typeof restrictive === 'number' ? 'Execution authorization or fence changed' : restrictive);
});

test('a restrictive hub stop preserves the independent missing-usage pause across restart', async t => {
  const f = finalizingChildFixture(t, { restrictive: 'Operator requested agent stop' });
  await work({ ...f.options, once: false, runClient: async (...args) => {
    try { return await f.options.runClient(...args); }
    catch (error) { throw Object.assign(error, { usageRecoveryError: 'PRIVATE checkpoint diagnostic' }); }
  } });
  assert.equal(f.sent.find(item => item.data.action === 'finish')?.data.note, 'Operator requested agent stop');
  assert.equal(f.sent.filter(item => item.data.action === 'claim').length, 1);
  const saved = JSON.parse(readFileSync(join(f.state, 'state.json'), 'utf8'));
  assert.equal(saved.usageAttention.jobId, 'coord-agent'); assert(!JSON.stringify(saved).includes('PRIVATE'));
  await assert.rejects(work({ ...f.options, fetch: async () => assert.fail('hub stop must not hide a durable usage pause') }), error => error.code === 'WORKER_USAGE_ATTENTION');
});
