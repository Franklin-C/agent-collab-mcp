import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveHandoff, git, githubRepository, inside, readHandoffSnapshot, recoveryCheckpoint, requestWorkerApi, restoreCheckpoint, work } from '../bin/worker.mjs';
import { executionBinding } from '../bin/client-adapters.mjs';
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
