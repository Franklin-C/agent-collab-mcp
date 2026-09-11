import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { enroll } from '../bin/enroll.mjs';
import { git, readHandoff } from '../bin/worker.mjs';
import { configureCodex } from '../bin/codex-config.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ehgi-enrollment-')), repo = join(root, 'repo'), state = join(root, 'state'), codexHome = join(root, 'codex'); mkdirSync(repo); mkdirSync(codexHome);
  git(repo, ['init', '-b', 'main']); git(repo, ['config', 'user.name', 'Test']); git(repo, ['config', 'user.email', 'test@example.test']);
  writeFileSync(join(repo, 'README.md'), 'fixture'); git(repo, ['add', '.']); git(repo, ['commit', '-m', 'base']); git(repo, ['remote', 'add', 'origin', 'https://github.com/fixture/repo.git']);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, repo, state, env: { ...process.env, CODEX_HOME: codexHome }, host: 'http://localhost', token: 'fixture', write: true, model: 'gpt-test', capability: { client: 'codex', compatible: true, profiles: true, version: 'fixture' }, fetch: async (_url, options) => {
    const packet = JSON.parse(options.body); return Response.json(packet.action === 'challenge' ? { challenge: randomUUID() } : { verified: true });
  } };
}
test('a successful HTTP probe cannot claim actual client readiness', async t => {
  const options = fixture(t);
  await assert.rejects(enroll({ ...options, runClient: async () => ({ completed: true }) }), /file-edit probe/);
  assert.equal(JSON.parse(readFileSync(join(options.state, 'state.json'))).enrollment, undefined);
});
test('client file proof and hub roundtrip both required before readiness is saved', async t => {
  const options = fixture(t); let turns = 0;
  const result = await enroll({ ...options, fetch: async (url, request) => {
    if (JSON.parse(request.body).action === 'verify') assert.equal(JSON.parse(readFileSync(join(options.state, 'worker.lock'))).phase, 'idle');
    return options.fetch(url, request);
  }, runClient: async (_client, prompt, run) => {
    assert.equal(run.env.AGENT_COLLAB_TOKEN, options.token);
    assert.equal(JSON.parse(readFileSync(join(options.state, 'worker.lock'))).phase, 'client_active');
    turns++; const proof = JSON.parse(prompt.match(/Write exactly ("[^"]+") into/)[1]);
    writeFileSync(join(run.cwd, prompt.match(/into (\.ehgi-enrollment-[a-f0-9-]+)/)[1]), proof);
    run.onUsage({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }); return { completed: true };
  } });
  assert.equal(turns, 1); assert.equal(result.verified, true);
  assert.equal(result.capabilities.verifiedExecution, true);
  assert.equal(JSON.parse(readFileSync(join(options.state, 'state.json'))).enrollment.repository, 'fixture/repo');
  assert.equal(JSON.parse(readFileSync(join(options.state, 'state.json'))).enrollment.capabilities.verifiedExecution, true);
});

test('live enrollment snapshots drain serially while the client is still running', { timeout: 5000 }, async t => {
  const options = fixture(t), delivered = []; let active = 0, peak = 0, clientRunning = false, release;
  const allDelivered = new Promise(resolve => { release = resolve; });
  await enroll({ ...options, fetch: async (url, request) => {
    if (url.endsWith('/api/usage/report')) {
      assert.equal(clientRunning, true); active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      delivered.push(JSON.parse(request.body)); active--;
      if (delivered.length === 2) release();
    }
    return options.fetch(url, request);
  }, runClient: async (_client, prompt, run) => {
    clientRunning = true;
    for (const input of [10, 20]) run.onUsage({ type: 'ehgi.codex_usage_snapshot', event_id: `snapshot-${input}`, usage: { input_tokens: input, output_tokens: 2, cached_input_tokens: 0 } });
    await allDelivered;
    writeFileSync(join(run.cwd, prompt.match(/into (\.ehgi-enrollment-[a-f0-9-]+)/)[1]), JSON.parse(prompt.match(/Write exactly ("[^"]+") into/)[1]));
    clientRunning = false; return { completed: true };
  } });
  assert.equal(peak, 1); assert(delivered.every(report => report.cumulative === true));
  assert.equal(delivered[0].session_id, delivered[1].session_id);
  assert.notEqual(delivered[0].event_id, delivered[1].event_id);
});

test('enrollment final delivery has a deadline and retains its unacknowledged event', async t => {
  const options = fixture(t), originalTimeout = globalThis.setTimeout; let attempted;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => originalTimeout(callback, ms === 5000 ? 30 : ms, ...args));
  await enroll({ ...options, fetch: async (url, request) => {
    if (url.endsWith('/api/usage/report')) {
      attempted = JSON.parse(request.body);
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled delivery'), { name: 'AbortError' })), { once: true });
      });
    }
    return options.fetch(url, request);
  }, runClient: async (_client, prompt, run) => {
    run.onUsage({ type: 'ehgi.codex_usage_snapshot', event_id: 'final', usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 5 } });
    writeFileSync(join(run.cwd, prompt.match(/into (\.ehgi-enrollment-[a-f0-9-]+)/)[1]), JSON.parse(prompt.match(/Write exactly ("[^"]+") into/)[1]));
    return { completed: true };
  } });
  assert.deepEqual(JSON.parse(readFileSync(join(options.state, 'state.json'))).usage, [attempted]);
});

test('enrollment forwards the selected profile and saves its exact local configuration binding', async t => {
  const options = fixture(t), profile = join(options.env.CODEX_HOME, 'ehgi.config.toml');
  writeFileSync(profile, 'approval_policy = "on-request"\napprovals_reviewer = "auto_review"\n');
  const { executionBinding } = await import('../bin/client-adapters.mjs');
  await enroll({ ...options, profile: 'ehgi', runClient: async (_client, prompt, run) => {
    assert.equal(run.profile, 'ehgi'); assert.equal(run.env.CODEX_HOME, options.env.CODEX_HOME);
    writeFileSync(join(run.cwd, prompt.match(/into (\.ehgi-enrollment-[a-f0-9-]+)/)[1]), JSON.parse(prompt.match(/Write exactly ("[^"]+") into/)[1]));
    run.onUsage({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } });
    return { completed: true };
  } });
  const saved = JSON.parse(readFileSync(join(options.state, 'state.json'))).enrollment;
  assert.deepEqual(saved.execution, executionBinding(options.capability, { ...options, profile: 'ehgi' }));
  assert(!JSON.stringify(saved.execution).includes('approval_policy'));
});

test('profile changes during a successful client probe cannot verify enrollment', async t => {
  const options = fixture(t), path = join(options.env.CODEX_HOME, 'ehgi.config.toml'); let verified = false;
  writeFileSync(path, 'approval_policy = "on-request"\n');
  await assert.rejects(enroll({ ...options, profile: 'ehgi', fetch: async (url, request) => {
    if (JSON.parse(request.body).action === 'verify') verified = true;
    return options.fetch(url, request);
  }, runClient: async (_client, prompt, run) => {
    writeFileSync(join(run.cwd, prompt.match(/into (\.ehgi-enrollment-[a-f0-9-]+)/)[1]), JSON.parse(prompt.match(/Write exactly ("[^"]+") into/)[1]));
    run.onUsage({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } });
    writeFileSync(path, 'approval_policy = "never"\n');
    return { completed: true };
  } }), /configuration changed during enrollment/);
  assert.equal(verified, false);
});

test('enrollment rejects missing model attribution before HTTP or model execution', async t => {
  const options = fixture(t); let requests = 0, turns = 0;
  await assert.rejects(enroll({ ...options, model: undefined, fetch: async () => { requests++; return Response.json({}); }, runClient: async () => { turns++; } }), /Specify --model/);
  assert.equal(requests, 0); assert.equal(turns, 0);
});

test('client proof without measurable usage cannot mark a worker ready', async t => {
  const options = fixture(t); let verified = false;
  await assert.rejects(enroll({ ...options, fetch: async (url, request) => { if (JSON.parse(request.body).action === 'verify') verified = true; return options.fetch(url, request); }, runClient: async (_client, prompt, run) => {
    writeFileSync(join(run.cwd, prompt.match(/into (\.ehgi-enrollment-[a-f0-9-]+)/)[1]), JSON.parse(prompt.match(/Write exactly ("[^"]+") into/)[1])); return { completed: true };
  } }), /no measurable usage/);
  assert.equal(verified, false);
  assert.match(JSON.parse(readFileSync(join(options.state, 'state.json'))).usageAttention.reason, /no estimate/);
});

test('missing enrollment accounting remains paused before any repeat HTTP or paid probe', async t => {
  const options = fixture(t); let turns = 0;
  await assert.rejects(enroll({ ...options, runClient: async () => {
    turns++; throw Object.assign(new Error('Cancelled'), { usageRecoveryError: 'Unavailable', sessionId: 'exact-session' });
  } }), /Cancelled/);
  const attention = JSON.parse(readFileSync(join(options.state, 'state.json'))).usageAttention;
  assert.equal(attention.sessionId, 'exact-session'); assert.match(attention.reason, /no estimate/);
  await assert.rejects(enroll({ ...options,
    fetch: async () => { throw new Error('Paused enrollment must not contact the hub'); },
    runClient: async () => { turns++; },
  }), error => error.code === 'WORKER_USAGE_ATTENTION' && error.retryable === false);
  assert.equal(turns, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(options.state, 'state.json'))).usageAttention, attention);
});

test('enrollment deduplicates repeated provider results while preserving every model report', async t => {
  const options = fixture(t), uploaded = [];
  await enroll({ ...options, capability: { client: 'claude-code', compatible: true, version: 'fixture' }, fetch: async (url, request) => {
    if (url.endsWith('/api/usage/report')) uploaded.push(JSON.parse(request.body));
    return options.fetch(url, request);
  }, runClient: async (_client, prompt, run) => {
    writeFileSync(join(run.cwd, prompt.match(/into (\.ehgi-enrollment-[a-f0-9-]+)/)[1]), JSON.parse(prompt.match(/Write exactly ("[^"]+") into/)[1]));
    const event = { type: 'result', uuid: 'same-provider-result', modelUsage: { first: { inputTokens: 10, outputTokens: 2 }, second: { inputTokens: 4, outputTokens: 1 } } };
    run.onUsage(event); run.onUsage(event); return { completed: true };
  } });
  assert.equal(uploaded.length, 2); assert.equal(new Set(uploaded.map(report => report.event_id)).size, 2);
  assert.equal(uploaded.reduce((total, report) => total + report.input_tokens, 0), 14);
});
test('handoff validation rejects missing, fabricated shape and excessive evidence', t => {
  const f = fixture(t); assert.throws(() => readHandoff(f.repo), /no .ehgi-handoff/);
  writeFileSync(join(f.repo, '.ehgi-handoff.json'), JSON.stringify({ outcome: 'deployed', summary: 'done' })); assert.throws(() => readHandoff(f.repo), /Invalid/);
  writeFileSync(join(f.repo, '.ehgi-handoff.json'), JSON.stringify({ outcome: 'more_work', summary: 'Checks need fixing', evidence: ['test failed'], nextSteps: ['Fix failing test'] }));
  assert.equal(readHandoff(f.repo).outcome, 'more_work');
});
test('Codex reconnect preserves name and unrelated settings and never duplicates a server', () => {
  const before = 'model = "test"\n[mcp_servers.agent-collab]\nurl = "https://ehgi.ai/api/mcp"\nbearer_token_env_var = "AGENT_COLLAB_TOKEN"\n[mcp_servers.other]\nurl = "https://example.test"\n';
  const after = configureCodex(before, 'https://ehgi.ai/api/mcp');
  assert.match(after, /tool_timeout_sec = 120/); assert.match(after, /model = "test"/); assert.doesNotMatch(after, /mcp_servers.agent_collab/);
  assert.equal(configureCodex(after, 'https://ehgi.ai/api/mcp'), after);
  assert.throws(() => configureCodex(after, 'https://other.test/api/mcp'), /differs/);
  assert.throws(() => configureCodex(before + '[mcp_servers.agent_collab]\n', 'https://ehgi.ai/api/mcp'), /Multiple/);
});

for (const stage of ['register', 'challenge']) {
  for (const [status, body, message] of [
    [401, '<html>Unauthorized</html>', 'Enrollment returned 401'],
    [403, 'null', 'Enrollment returned 403'],
    [502, '', 'Enrollment returned 502'],
    [503, 'not JSON', 'Enrollment returned 503'],
    [409, '{"error":"The enrollment challenge changed."}', 'The enrollment challenge changed.'],
    [503, '{"error":{"private":"unexpected payload"}}', 'Enrollment returned 503'],
  ]) test(`enrollment ${stage} preserves HTTP ${status} without starting a client: ${body.slice(0, 12)}`, async t => {
    const options = fixture(t), actions = []; let turns = 0;
    await assert.rejects(enroll({ ...options, fetch: async (url, request) => {
      assert.equal(url, `${options.host}/api/agent/worker`);
      assert.equal(request.redirect, 'error');
      const packet = JSON.parse(request.body); actions.push(packet.action);
      return packet.action === stage ? new Response(body, { status }) : Response.json({ registered: true });
    }, runClient: async () => { turns++; } }), error => error.status === status && error.message === message);
    assert.deepEqual(actions, stage === 'register' ? ['register'] : ['register', 'challenge']);
    assert.equal(turns, 0);
    assert.equal(existsSync(join(options.state, 'enrollment')), false);
    assert.equal(existsSync(join(options.state, 'worker.lock')), false);
    assert.equal(JSON.parse(readFileSync(join(options.state, 'state.json'))).enrollment, undefined);
  });
  for (const body of ['<html>Invalid success</html>', 'null', '[]']) test(`enrollment ${stage} rejects malformed successful response ${body} before a client`, async t => {
    const options = fixture(t), actions = []; let turns = 0;
    await assert.rejects(enroll({ ...options, fetch: async (_url, request) => {
      const packet = JSON.parse(request.body); actions.push(packet.action);
      return packet.action === stage ? new Response(body, { status: 200 }) : Response.json({ registered: true });
    }, runClient: async () => { turns++; } }), error => error instanceof SyntaxError || /invalid response object/.test(error.message));
    assert.deepEqual(actions, stage === 'register' ? ['register'] : ['register', 'challenge']);
    assert.equal(turns, 0);
    assert.equal(existsSync(join(options.state, 'worker.lock')), false);
    assert.equal(JSON.parse(readFileSync(join(options.state, 'state.json'))).enrollment, undefined);
  });
}

test('a malformed HTTP verification error preserves final usage and releases the enrollment lock', async t => {
  const options = fixture(t), reports = []; let turns = 0;
  await assert.rejects(enroll({ ...options, fetch: async (url, request) => {
    if (url.endsWith('/api/usage/report')) { reports.push(JSON.parse(request.body)); return new Response('', { status: 503 }); }
    const packet = JSON.parse(request.body);
    if (packet.action === 'verify') return new Response('<html>Gateway unavailable</html>', { status: 503 });
    return options.fetch(url, request);
  }, runClient: async (_client, prompt, run) => {
    turns++;
    writeFileSync(join(run.cwd, prompt.match(/into (\.ehgi-enrollment-[a-f0-9-]+)/)[1]), JSON.parse(prompt.match(/Write exactly ("[^"]+") into/)[1]));
    run.onUsage({ type: 'ehgi.codex_usage_snapshot', event_id: 'final', usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 5 } });
    return { completed: true };
  } }), error => error.status === 503 && error.message === 'Enrollment returned 503');
  assert.equal(turns, 1, 'The injected fixture ran once; no real provider was called');
  assert.ok(reports.length >= 1);
  const state = JSON.parse(readFileSync(join(options.state, 'state.json')));
  assert.equal(state.enrollment, undefined);
  assert.deepEqual(state.usage, [reports[0]]);
  assert.ok(reports.every(report => JSON.stringify(report) === JSON.stringify(reports[0])));
  assert.equal(existsSync(join(options.state, 'worker.lock')), false);
});
