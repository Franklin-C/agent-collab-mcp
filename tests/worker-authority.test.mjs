import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { git, work } from '../bin/worker.mjs';
import { createAuthorityGuard } from '../bin/worker-authority.mjs';

const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const abortError = () => Object.assign(new Error('Synthetic client stopped'), { name: 'AbortError', retryable: false });
async function settle() { for (let index = 0; index < 3; index++) await yieldLoop(); }

function controlledClock(t) {
  let now = 0, nextId = 0;
  const timers = new Map();
  const setTimer = (callback, ms, repeat = false, args = []) => {
    const handle = { id: ++nextId, unref() { return this; } };
    timers.set(handle, { callback, at: now + ms, repeat: repeat ? ms : 0, args });
    return handle;
  };
  const clearTimer = handle => timers.delete(handle);
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => setTimer(callback, ms, false, args));
  t.mock.method(globalThis, 'clearTimeout', clearTimer);
  t.mock.method(globalThis, 'setInterval', (callback, ms, ...args) => setTimer(callback, ms, true, args));
  t.mock.method(globalThis, 'clearInterval', clearTimer);
  t.mock.method(performance, 'now', () => now);
  const epoch = Date.now();
  t.mock.method(Date, 'now', () => epoch + now);
  return {
    now: () => now, setTimer, clearTimer,
    jumpWithoutTimers(ms) { now += ms; },
    async advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0].id - b[0].id)[0];
        if (!next) break;
        const [handle, timer] = next;
        now = timer.at;
        if (timer.repeat) timer.at += timer.repeat; else timers.delete(handle);
        timer.callback(...timer.args);
        await settle();
      }
      now = target; await settle();
    },
    sleep(ms, signal) {
      return new Promise((resolve, reject) => {
        const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
        const abort = () => { clearTimer(timer); reject(abortError()); };
        const timer = setTimer(done, ms);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    },
  };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'worker-authority-'));
  const repo = join(root, 'repo'), state = join(root, 'state');
  mkdirSync(repo); mkdirSync(state);
  git(repo, ['init', '-b', 'main']); git(repo, ['config', 'core.autocrlf', 'false']);
  git(repo, ['config', 'user.name', 'Authority fixture']); git(repo, ['config', 'user.email', 'authority@example.test']);
  writeFileSync(join(repo, 'fixture.txt'), 'synthetic local source\n');
  git(repo, ['add', '.']); git(repo, ['commit', '-m', 'fixture']);
  const sha = git(repo, ['rev-parse', 'HEAD']).trim();
  git(repo, ['remote', 'add', 'origin', 'https://github.com/fixture/repo.git']);
  git(repo, ['update-ref', 'refs/remotes/origin/main', sha]);
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('worker-authority-'));
    rmSync(root, { recursive: true, force: true });
  });
  return { repo, state };
}

async function startWorker(t, clock, transport, controls = {}) {
  const f = fixture(t), stop = new AbortController();
  const observation = { claims: 0, turns: 0, heartbeats: 0, usage: [], signal: null, cleanup: false, logs: [] };
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const running = work({ host: 'http://127.0.0.1', token: 'synthetic-fixture', repo: f.repo, state: f.state, write: true, model: 'test-model', capability: { client: 'codex', version: 'test' }, once: false, signal: stop.signal, log: message => observation.logs.push(message),
    authorityClock: clock,
    ...(controls.checkpoint ? { checkpoint: (...args) => controls.checkpoint(...args, observation) } : {}),
    git: (cwd, args) => args[0] === 'fetch' ? '' : git(cwd, args),
    wait: (ms, signal) => clock.sleep(ms, signal),
    fetch: async (url, request) => {
      const data = JSON.parse(request.body);
      if (data.action === 'claim') {
        observation.claims++;
        // A third claim ends a regressed continuous worker without looping.
        if (observation.claims > 2) return response({ stop: true, job: null });
        return response({ job: { id: `coord-${observation.claims}`, kind: controls.implementation ? 'implementation' : 'coordination', ...(controls.implementation ? { task: { id: `coord-${observation.claims}`, number: observation.claims, leaseVersion: 1, branch: 'fixture/publication' } } : {}), fence: 1, maxMinutes: 5, maxCostUsd: 2, assignment: { kind: 'review', instruction: 'Synthetic authority fixture only' } }, repository: { owner: 'fixture', repo: 'repo', base: 'main' } });
      }
      if (url.endsWith('/api/usage/report')) observation.usage.push(data);
      if (data.action === 'heartbeat') observation.heartbeats++;
      const defaultResult = () => response(url.endsWith('/api/agent/activity') ? { acceptedThrough: data.events.at(-1).sequence } : data.action === 'heartbeat' ? { stop: false } : { recorded: true });
      if (observation.cleanup) return defaultResult();
      const result = await transport({ url, request, data, observation, clock });
      return result ?? defaultResult();
    },
    runClient: async (_capability, _prompt, args) => {
      observation.turns++; observation.signal = args.signal;
      if (controls.activity) args.onActivity({ kind: 'tool_started', tool: 'command' });
      // Synthetic delivery exercises the local outbox. No provider is called.
      args.onUsage({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
      ready();
      if (observation.turns > 1) { stop.abort(); throw abortError(); }
      await new Promise((resolve, reject) => {
        args.signal.addEventListener('abort', () => {
          if (controls.finalUsageOnAbort) args.onUsage({ type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 2 } });
          reject(abortError());
        }, { once: true });
        if (args.signal.aborted) reject(abortError());
      });
    },
  });
  // Install rejection handling before driving the mocked transport clock.
  const outcome = running.then(value => ({ value }), error => ({ error }));
  await Promise.race([started, outcome.then(result => { throw result.error ?? new Error(`Fixture returned before client start: ${observation.logs.join('; ')}`); })]); await settle();
  return { ...f, observation, outcome, async close() { observation.cleanup = true; stop.abort(); await settle(); await clock.advance(5001); await outcome; } };
}

test('usage retries cannot keep the local client running beyond the last acknowledged execution lease', async t => {
  const clock = controlledClock(t);
  let usageAttempts = 0, runningHeartbeats = 0;
  const f = await startWorker(t, clock, async ({ url, request, data, observation }) => {
    if (url.endsWith('/api/usage/report')) {
      usageAttempts++; await clock.sleep(20000, request.signal);
      return response({}, usageAttempts < 3 ? 503 : 200);
    }
    if (data.action === 'heartbeat' && observation.turns) {
      runningHeartbeats++;
      await clock.sleep(20000, request.signal);
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } });
    }
  });
  try {
    assert.equal(f.observation.signal.aborted, false);
    await clock.advance(63000);
    assert.equal(usageAttempts, 3);
    assert.equal(runningHeartbeats, 1);
    assert.equal(f.observation.signal.aborted, false, 'the most recent authority still covers this point');
    await clock.advance(17000);
    assert.equal(f.observation.signal.aborted, true, 'the 80-second local deadline leaves 10 seconds to terminate before server expiry');
    assert.equal(f.observation.turns, 1);
  } finally { await f.close(); }
});

test('a successful delayed heartbeat renews from request start, not receipt', async t => {
  const clock = controlledClock(t), expired = [];
  const guard = createAuthorityGuard({ ...clock, onExpire: error => expired.push(error) });
  guard.accept(0);
  await clock.advance(20000);
  const requestStartedAt = clock.now();
  await clock.advance(20000);
  guard.accept(requestStartedAt);
  await clock.advance(59999);
  assert.doesNotThrow(() => guard.check()); assert.equal(expired.length, 0);
  await clock.advance(1);
  assert.throws(() => guard.check(), { code: 'WORKER_AUTHORITY_EXPIRED' });
  assert.equal(expired.length, 1, 'receipt at 40s must not extend authority to 120s');
  guard.close();
});

test('a delayed timer and a late successful acknowledgement cannot revive expired authority', t => {
  const clock = controlledClock(t), expired = [];
  const guard = createAuthorityGuard({ ...clock, onExpire: error => expired.push(error) });
  guard.accept(0);
  clock.jumpWithoutTimers(80001);
  assert.throws(() => guard.accept(70000), { code: 'WORKER_AUTHORITY_EXPIRED' });
  assert.throws(() => guard.check(), error => error === expired[0]);
  assert.throws(() => guard.accept(clock.now()), error => error === expired[0]);
  assert.equal(expired.length, 1);
  guard.close();
});

for (const [advertised, deadline] of [[30000, 20000], [90000, 80000], [180000, 80000]]) test(`lease advertisement ${advertised} retains the conservative local deadline`, async t => {
  const clock = controlledClock(t), expired = [];
  const guard = createAuthorityGuard({ ...clock, onExpire: error => expired.push(error) });
  guard.accept(0, advertised);
  await clock.advance(deadline - 1); assert.doesNotThrow(() => guard.check());
  await clock.advance(1); assert.throws(() => guard.check(), { code: 'WORKER_AUTHORITY_EXPIRED' });
  assert.equal(expired.length, 1); guard.close();
});

test('invalid or already consumed lease evidence fails permanently', t => {
  const clock = controlledClock(t);
  for (const duration of [null, 0, -1, 0.5, Number.NaN, '90000', 10000]) {
    const expired = [], guard = createAuthorityGuard({ ...clock, onExpire: error => expired.push(error) });
    assert.throws(() => guard.accept(0, duration), { code: 'WORKER_AUTHORITY_EXPIRED' });
    assert.throws(() => guard.accept(0), error => error === expired[0]);
    assert.equal(expired.length, 1); guard.close();
  }
});

test('closing the authority guard cancels its timer without a later expiry callback', async t => {
  const clock = controlledClock(t), expired = [];
  const guard = createAuthorityGuard({ ...clock, onExpire: error => expired.push(error) });
  guard.accept(0); guard.close(); await clock.advance(90000);
  assert.equal(expired.length, 0);
  assert.throws(() => guard.accept(clock.now()), /closed/);
});

test('a delayed heartbeat body cannot keep a client alive or revive it when its acknowledgement finally arrives', async t => {
  const clock = controlledClock(t);
  let delayed = false, bodyReturned = false;
  const f = await startWorker(t, clock, async ({ data, observation }) => {
    if (data.action === 'heartbeat' && observation.turns && !delayed) {
      delayed = true;
      // Model a response reader that does not settle promptly on abort.
      return { ok: true, status: 200, async json() { await clock.sleep(90000); bodyReturned = true; return { stop: false }; } };
    }
  });
  try {
    assert.equal(delayed, true);
    await clock.advance(80000);
    assert.equal(f.observation.signal.aborted, true);
    assert.equal(bodyReturned, false, 'termination must be independent of the pending body reader');
    await clock.advance(10000);
    assert.equal(bodyReturned, true);
    assert.equal(f.observation.turns, 1); assert.equal(f.observation.claims, 1);
  } finally { await f.close(); }
});

test('an unreadable heartbeat authority acknowledgement cannot renew or start another client', async t => {
  const clock = controlledClock(t);
  let malformed = false;
  const f = await startWorker(t, clock, async ({ data, observation }) => {
    if (data.action === 'heartbeat' && observation.turns && !malformed) { malformed = true; return response({}); }
  });
  try {
    await settle();
    assert.equal(malformed, true); assert.equal(f.observation.signal.aborted, true);
    assert.equal(f.observation.turns, 1); assert.equal(f.observation.claims, 1);
    assert.ok(f.observation.logs.some(message => message.includes('did not confirm execution authority')));
  } finally { await f.close(); }
});

test('an explicit operator Stop immediately aborts the current local client', async t => {
  const clock = controlledClock(t);
  let stoppedSignal, observedStop = false;
  const f = await startWorker(t, clock, async ({ data, observation }) => {
    if (data.action === 'heartbeat' && observation.turns && !observedStop) {
      observedStop = true; stoppedSignal = observation.signal;
      return response({ stop: true, reason: 'Operator requested agent stop' });
    }
    if (data.action === 'heartbeat' && observation.turns) return response({ stop: true, reason: 'Operator requested agent stop' });
  });
  try {
    await settle(); assert.equal(observedStop, true); assert.equal(stoppedSignal.aborted, true);
    assert.equal(f.observation.turns, 1);
  } finally { await f.close(); }
});

test('the worker applies a successful delayed renewal using the heartbeat request start', async t => {
  const clock = controlledClock(t);
  let runningHeartbeats = 0;
  const f = await startWorker(t, clock, async ({ data, request, observation }) => {
    if (data.action === 'heartbeat' && observation.turns) {
      runningHeartbeats++;
      if (runningHeartbeats === 2) await clock.sleep(20000, request.signal);
      if (runningHeartbeats >= 3) await clock.sleep(120000, request.signal);
      return response({ stop: false });
    }
  });
  try {
    await clock.advance(40000);
    assert.equal(runningHeartbeats, 3);
    await clock.advance(59999);
    assert.equal(f.observation.signal.aborted, false, 'renewal at request time 20s extends the original 80s deadline to 100s');
    await clock.advance(1);
    assert.equal(f.observation.signal.aborted, true, 'response receipt at 40s must not grant authority until 120s');
    assert.equal(f.observation.turns, 1); assert.equal(f.observation.claims, 1);
  } finally { await f.close(); }
});

test('lease expiry aborts an asynchronous checkpoint without allowing its local client to continue', async t => {
  const clock = controlledClock(t);
  let checkpointSignal;
  const f = await startWorker(t, clock, async () => undefined, { implementation: true,
    checkpoint: async (_cwd, baseSha, _directory, signal, observation) => {
      if (observation.turns) { checkpointSignal = signal; await clock.sleep(120000, signal); }
      return { baseSha, patch: '', digest: createHash('sha256').update('').digest('hex') };
    },
  });
  try {
    assert.ok(checkpointSignal); assert.equal(checkpointSignal.aborted, false);
    await clock.advance(80000);
    assert.equal(checkpointSignal.aborted, true);
    assert.equal(f.observation.signal.aborted, true);
    assert.equal(f.observation.turns, 1); assert.equal(f.observation.claims, 1);
  } finally { await f.close(); }
});

test('a one-shot activity authorization denial stops the client and the continuous worker', async t => {
  const clock = controlledClock(t);
  let denied = false;
  const f = await startWorker(t, clock, async ({ url }) => {
    if (url.endsWith('/api/agent/activity') && !denied) { denied = true; return response({ error: 'Synthetic activity authorization rejected' }, 401); }
  }, { activity: true });
  try {
    await clock.advance(5000);
    assert.equal(denied, true); assert.equal(f.observation.signal.aborted, true);
    assert.equal(f.observation.turns, 1); assert.equal(f.observation.claims, 1);
  } finally { await f.close(); }
});

test('a final usage-drain authorization denial retains its report and stops continuous work', async t => {
  const clock = controlledClock(t);
  let denied = false;
  const f = await startWorker(t, clock, async ({ url, data, observation }) => {
    if (url.endsWith('/api/usage/report') && data.output_tokens === 2 && !denied) {
      assert.equal(observation.signal.aborted, true, 'this recovered report is emitted only after the client stops');
      denied = true; return response({ error: 'Synthetic final usage authorization rejected' }, 403);
    }
    if (data.action === 'heartbeat' && observation.turns) return response({ stop: true, reason: 'Job cost limit reached' });
  }, { finalUsageOnAbort: true });
  try {
    await settle();
    assert.equal(denied, true); assert.equal(f.observation.turns, 1); assert.equal(f.observation.claims, 1);
    const saved = JSON.parse(readFileSync(join(f.state, 'state.json'), 'utf8'));
    assert.equal(saved.usage.length, 1); assert.equal(saved.usage[0].output_tokens, 2);
    assert.equal(saved.usage[0].event_id, f.observation.usage.at(-1).event_id);
  } finally { await f.close(); }
});

for (const status of [401, 403]) test(`a running ${status} acknowledgement stops continuous work even if later endpoints recover`, async t => {
  const clock = controlledClock(t);
  let denied = false;
  const f = await startWorker(t, clock, async ({ data, observation }) => {
    if (data.action === 'heartbeat' && observation.turns && !denied) { denied = true; return response({ error: 'Synthetic authorization rejected' }, status); }
  });
  try {
    await settle(); await clock.advance(1000);
    assert.equal(denied, true);
    assert.equal(f.observation.signal.aborted, true);
    assert.equal(f.observation.claims, 1, 'authorization loss must terminate this continuous worker');
    assert.equal(f.observation.turns, 1, 'recovering endpoints must not start another client without operator resumption');
    const state = JSON.parse(readFileSync(join(f.state, 'state.json'), 'utf8'));
    assert.ok(state.active, 'the last execution remains available for inspection');
  } finally { await f.close(); }
});
