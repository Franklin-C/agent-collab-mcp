import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

import { runClient } from '../bin/client-adapters.mjs';
import { enroll } from '../bin/enroll.mjs';
const capture = tmpdir();
const sessionId = '01a08a86-95c6-7e90-8bed-46d6ab6c55a0';
const capability = { client: 'codex', executable: 'never-launch-this-fixture', compatible: true, version: 'fixture' };
const record = value => JSON.stringify(value) + '\n';
const totals = input => ({ input_tokens: input, cached_input_tokens: 3, output_tokens: 2 });
const completion = input => ({ type: 'turn.completed', usage: totals(input) });
const tick = () => new Promise(resolve => setImmediate(resolve));

// Every timer/signal/process boundary is intercepted. Checkpoint reads use only
// a newly owned fixture directory. No native child, network or credential exists.
function fixture(t, { native = false, onUsage } = {}) {
  const root = mkdtempSync(join(capture, 'ehgi-client-timeout-'));
  const cwd = join(root, 'repo'), home = join(root, 'home');
  const day = join(home, 'sessions', '2026', '09', '10');
  mkdirSync(cwd); mkdirSync(day, { recursive: true });
  const file = join(day, `rollout-2026-09-10T04-54-31-${sessionId}.jsonl`);
  const timers = [], intervals = [], signals = [], kills = [], activity = [], reports = [];
  const child = new EventEmitter();
  child.pid = 424242; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { throw Error('Unexpected direct-child signal fallback'); };
  const controller = new AbortController();
  let groupGone = false, spawned = 0, spawnedResolve;
  const spawnedPromise = new Promise(resolve => { spawnedResolve = resolve; });
  function timer(callback, ms, list) {
    const entry = { callback, ms, cleared: false, unref() { return this; } };
    list.push(entry); return entry;
  }
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => timer(callback, ms, timers));
  t.mock.method(globalThis, 'setInterval', (callback, ms) => timer(callback, ms, intervals));
  t.mock.method(globalThis, 'clearTimeout', timer => { if (timer) timer.cleared = true; });
  t.mock.method(globalThis, 'clearInterval', timer => { if (timer) timer.cleared = true; });
  t.mock.method(globalThis, 'fetch', () => { throw Error('Network is forbidden'); });
  t.mock.method(childProcess, 'execFileSync', () => { throw Error('Native commands are forbidden'); });
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    assert.equal(command, 'taskkill');
    assert.deepEqual(args, ['/PID', '424242', '/T', '/F']);
    assert.equal(options.windowsHide, true); assert.equal(options.stdio, 'ignore');
    kills.push('owned-tree-stop'); return new EventEmitter();
  });
  t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, -424242); signals.push(signal);
    if (groupGone) throw Object.assign(Error('Fixture group is gone'), { code: 'ESRCH' });
    return true;
  });
  syncBuiltinESMExports();
  t.after(() => {
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    t.mock.restoreAll(); syncBuiltinESMExports();
    assert.ok(resolve(root).startsWith(resolve(capture) + sep));
    rmSync(root, { recursive: true, force: true });
  });
  const options = {
    cwd, env: { CODEX_HOME: home }, timeoutMs: 180000, signal: controller.signal,
    spawn: () => { spawned++; spawnedResolve(); return child; },
    onActivity: value => activity.push(value),
    ...(native ? { onUsage: async value => { reports.push(value); await onUsage?.(value); } } : {}),
  };
  function checkpoint(input) {
    writeFileSync(file, record({ type: 'session_meta', payload: { id: sessionId, session_id: sessionId, source: 'exec', cwd } })
      + record({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: totals(input) } } }));
  }
  const emit = value => child.stdout.write(record(value));
  const close = (code = 0) => {
    child.stdout.end(); child.stderr.end(); child.emit('exit', code, null); child.emit('close', code, null);
    groupGone = true;
    for (const interval of intervals.filter(timer => timer.ms === 100 && !timer.cleared)) interval.callback();
  };
  const fire = () => {
    const deadline = timers.find(timer => timer.ms === 180000);
    assert.ok(deadline, 'The unchanged configured deadline must be installed');
    const before = Date.now(); deadline.callback(); const after = Date.now();
    return { before, after };
  };
  function begin() {
    const client = native ? capability : { client: 'claude-code', executable: 'never-launch-this-fixture' };
    const running = runClient(client, 'synthetic fixture', options);
    const result = running.then(value => ({ value }), error => ({ error }));
    return { result, ready: spawnedPromise.then(() => { if (native) emit({ type: 'thread.started', thread_id: sessionId }); }) };
  }
  return { root, cwd, home, file, controller, child, options, begin, emit, close, fire, checkpoint, timers, intervals, kills, signals, activity, reports, spawned: () => spawned };
}

function assertTimestamp(error, bounds) {
  assert.match(error.timedOutAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Date.parse(error.timedOutAt) >= bounds.before && Date.parse(error.timedOutAt) <= bounds.after);
  assert.ok(error.message.includes(`Client run deadline exceeded at ${error.timedOutAt}. Events remain pending.`));
}

test('own deadline records its time, waits for close, and rejects a late successful completion without retry', async t => {
  const f = fixture(t), run = f.begin(); await run.ready;
  let settled = false; run.result.then(() => { settled = true; });
  const bounds = f.fire(); await tick();
  assert.equal(settled, false); assert.deepEqual(f.activity, [{ kind: 'run_started' }]);
  f.emit({ type: 'result', is_error: false }); f.close(0);
  const { error, value } = await run.result;
  assert.equal(value, undefined); assert.equal(error.code, 'CLIENT_TIMEOUT'); assert.equal(error.retryable, false);
  assertTimestamp(error, bounds); assert.equal(error.usageRecoveryError, undefined);
  assert.equal(error.message, `Client run deadline exceeded at ${error.timedOutAt}. Events remain pending.`);
  assert.equal(f.spawned(), 1); assert.equal(f.activity.at(-1).kind, 'run_failed');
  assert.equal(process.platform === 'win32' ? f.kills.length : f.signals.filter(x => x === 'SIGTERM').length, 1);
});

test('normal completion clears the timer and an already-queued timeout callback cannot relabel it', async t => {
  const f = fixture(t), run = f.begin(); await run.ready;
  f.emit({ type: 'result', is_error: false }); f.close();
  const { value, error } = await run.result;
  assert.equal(error, undefined); assert.equal(value.completed, true);
  assert.equal(f.timers.find(x => x.ms === 180000).cleared, true);
  f.fire(); assert.deepEqual(f.kills, []); assert.deepEqual(f.signals, []);
  assert.deepEqual(f.activity, [{ kind: 'run_started' }, { kind: 'run_finished' }]);
});

test('repeated deadline callbacks keep the first timestamp and a single Stop obligation', async t => {
  const f = fixture(t), run = f.begin(); await run.ready;
  const RealDate = Date; let now = RealDate.UTC(2026, 8, 10, 12, 0, 0);
  t.mock.method(globalThis, 'Date', class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
  });
  t.mock.method(Date, 'now', () => now);
  const bounds = f.fire(); now += 10000; f.fire();
  f.emit({ type: 'result', is_error: false }); f.close();
  const { error } = await run.result;
  assert.equal(error.code, 'CLIENT_TIMEOUT'); assertTimestamp(error, bounds);
  assert.equal(error.timedOutAt, '2026-09-10T12:00:00.000Z');
  assert.equal(process.platform === 'win32' ? f.kills.length : f.signals.filter(x => x === 'SIGTERM').length, 1);
});

test('ordinary provider failure before the deadline is not classified as a timeout', async t => {
  const f = fixture(t), run = f.begin(); await run.ready;
  f.emit({ type: 'result', is_error: true }); f.close(1);
  const { error } = await run.result;
  assert.equal(error.code, undefined); assert.equal(error.timedOutAt, undefined);
  assert.match(error.message, /turn did not complete/); assert.equal(f.activity.at(-1).kind, 'run_failed');
});

for (const ownDeadline of [false, true]) test(`external Stop retains AbortError (own deadline also fired: ${ownDeadline})`, async t => {
  const f = fixture(t), run = f.begin(); await run.ready;
  f.controller.abort(); const bounds = ownDeadline ? f.fire() : null;
  f.emit({ type: 'result', is_error: false }); f.close();
  const { error } = await run.result;
  assert.equal(error.name, 'AbortError'); assert.equal(error.code, undefined); assert.equal(error.retryable, false);
  if (ownDeadline) assertTimestamp(error, bounds); else assert.equal(error.timedOutAt, undefined);
  assert.equal(f.activity.at(-1).kind, 'run_stopped'); assert.equal(f.spawned(), 1);
});

test('timeout waits for the durable sink and final native checkpoint without losing or duplicating usage', async t => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { native: true, onUsage: value => value.usage.input_tokens === 10 ? held : undefined });
  f.checkpoint(17); const run = f.begin(); await run.ready;
  const bounds = f.fire(); f.emit(completion(10)); f.close();
  let settled = false; run.result.then(() => { settled = true; });
  await tick(); assert.equal(settled, false); assert.deepEqual(f.reports.map(x => x.usage), [totals(10)]);
  release(); const { error } = await run.result;
  assert.equal(error.code, 'CLIENT_TIMEOUT'); assertTimestamp(error, bounds); assert.equal(error.usageRecoveryError, undefined);
  assert.deepEqual(f.reports.map(x => x.usage), [totals(10), totals(17)]);
  assert.equal(new Set(f.reports.map(x => x.event_id)).size, 2);
  assert.equal(f.activity.at(-1).kind, 'run_failed'); assert.equal(f.spawned(), 1);
});

for (const externalStop of [false, true]) test(`missing native checkpoint preserves unknown accounting on timeout (external Stop: ${externalStop})`, async t => {
  const f = fixture(t, { native: true }), run = f.begin(); await run.ready;
  const bounds = f.fire(); if (externalStop) f.controller.abort();
  // A late terminal stdout counter is insufficient to prove an interrupted run's final usage.
  f.emit(completion(10)); f.close();
  const { error } = await run.result;
  if (externalStop) { assert.equal(error.name, 'AbortError'); assert.equal(error.code, undefined); }
  else assert.equal(error.code, 'CODEX_USAGE_UNAVAILABLE');
  assert.equal(error.retryable, false); assert.match(error.usageRecoveryError, /no token estimate/); assertTimestamp(error, bounds);
  assert.deepEqual(f.reports.map(x => x.usage), [totals(10)]);
  assert.equal(f.activity.at(-1).kind, externalStop ? 'run_stopped' : 'run_failed');
});

test('deadline failure retains the separately verified CLI-update hint and exact native counters', async t => {
  const f = fixture(t, { native: true }); f.checkpoint(17); const run = f.begin(); await run.ready;
  const bounds = f.fire();
  f.emit({ type: 'turn.failed', error: { message: JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again." } }) } });
  f.close(1); const { error } = await run.result;
  assert.equal(error.code, 'CLIENT_TIMEOUT'); assert.equal(error.requiresUpdate, true); assertTimestamp(error, bounds);
  assert.match(error.message, /newer Codex CLI/); assert(!error.message.includes('gpt-6-astra'));
  assert.deepEqual(f.reports.map(x => x.usage), [totals(17)]);
});

test('real enrollment retains the timeout accounting pause and refuses a repeat before HTTP or native work', async t => {
  const f = fixture(t, { native: true }), state = join(f.root, 'state'); let calls = 0, turns = 0;
  t.mock.method(childProcess, 'execFileSync', (_command, args) => {
    if (JSON.stringify(args) === JSON.stringify(['remote', 'get-url', 'origin'])) return 'https://github.com/fixture/repo.git\n';
    if (args[0] === 'worktree' && args[1] === 'add') { mkdirSync(args[3], { recursive: true }); return ''; }
    throw Error('Unexpected native boundary');
  }); syncBuiltinESMExports();
  const options = { repo: f.cwd, state, env: { CODEX_HOME: f.home }, host: 'http://127.0.0.1', token: 'synthetic-fixture', model: 'gpt-fixture', write: true, capability,
    fetch: async (_url, request) => { calls++; const body = JSON.parse(request.body); return Response.json(body.action === 'challenge' ? { challenge: '00000000-0000-4000-8000-000000000000' } : {}); },
    runClient: async (client, prompt, selected) => {
      turns++;
      const outcome = runClient(client, prompt, { ...selected, spawn: f.options.spawn }).then(value => ({ value }), error => ({ error }));
      await tick(); f.emit({ type: 'thread.started', thread_id: sessionId }); f.fire(); f.close(1);
      const { error, value } = await outcome; if (error) throw error; return value;
    },
  };
  await assert.rejects(enroll(options), error => error.code === 'CODEX_USAGE_UNAVAILABLE' && typeof error.timedOutAt === 'string');
  const saved = JSON.parse(readFileSync(join(state, 'state.json'), 'utf8'));
  assert.equal(saved.enrollment, undefined); assert.equal(saved.usageAttention.sessionId, sessionId);
  assert.match(saved.usageAttention.reason, /no estimate/); assert.deepEqual(saved.usage, []);
  const priorCalls = calls;
  await assert.rejects(enroll(options), error => error.code === 'WORKER_USAGE_ATTENTION' && error.retryable === false);
  assert.equal(calls, priorCalls); assert.equal(turns, 1); assert.equal(f.spawned(), 1);
  assert.deepEqual(JSON.parse(readFileSync(join(state, 'state.json'), 'utf8')).usageAttention, saved.usageAttention);
});
