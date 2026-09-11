import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { runClient } from '../bin/client-adapters.mjs';

// These are event-contract controls, not POSIX runtime evidence. Every signal
// and timer is intercepted; client-stop.test.mjs exercises real process groups.
function fixture(t, signal, options = {}) {
  const timers = [], intervals = [], signals = [], directKills = [];
  const timer = (callback, ms, list) => {
    const handle = { callback, ms, cleared: false, referenced: true, unref() { this.referenced = false; return this; } };
    list.push(handle); return handle;
  };
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => timer(callback, ms, timers));
  t.mock.method(globalThis, 'setInterval', (callback, ms) => timer(callback, ms, intervals));
  t.mock.method(globalThis, 'clearTimeout', handle => { if (handle) handle.cleared = true; });
  t.mock.method(globalThis, 'clearInterval', handle => { if (handle) handle.cleared = true; });
  t.mock.method(process, 'kill', (pid, name) => { signals.push({ pid, name }); return signal?.(pid, name) ?? true; });
  const child = new EventEmitter();
  child.pid = Object.hasOwn(options, 'pid') ? options.pid : 424242; child.exitCode = null; child.signalCode = null;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = name => { directKills.push(name); return true; };
  t.after(() => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
  const controller = new AbortController(), activity = [];
  const promise = runClient({ client: 'claude-code', executable: 'unused-test-double' }, 'fixture', {
    signal: controller.signal, spawn: () => child, onActivity: event => activity.push(event.kind),
  });
  const close = () => { child.exitCode = 0; child.emit('exit', 0, null); child.emit('close', 0, null); };
  return { child, controller, promise, close, activity, timers, intervals, signals, directKills };
}
const posix = { skip: process.platform === 'win32' ? 'Contract for POSIX process-group signaling only' : false };

test('Stop keeps one referenced group obligation through close using its immutable group id', posix, async t => {
  const f = fixture(t);
  const rejected = assert.rejects(f.promise, error => error.name === 'AbortError' && error.retryable === false);
  f.controller.abort();
  const escalation = f.timers.find(timer => timer.ms === 5000);
  assert.ok(escalation?.referenced);
  // Repeated timeout/Stop cannot schedule additional escalation attempts.
  f.timers.find(timer => timer.ms === 15 * 60000).callback();
  assert.equal(f.timers.filter(timer => timer.ms === 5000).length, 1);
  f.child.pid = 999999; f.close();
  await Promise.resolve();
  assert.deepEqual(f.activity, ['run_started']);
  assert.equal(escalation.cleared, false);
  escalation.callback(); await rejected;
  assert.deepEqual(f.signals, [{ pid: -424242, name: 'SIGTERM' }, { pid: -424242, name: 'SIGKILL' }]);
  assert.deepEqual(f.directKills, []); assert.deepEqual(f.activity, ['run_started', 'run_stopped']);
  assert.equal(f.intervals[0].cleared, true);
});

test('an observed missing group permanently cancels escalation even if the numeric id returns', posix, async t => {
  let missing = false;
  const f = fixture(t, () => { if (missing) throw Object.assign(Error('No such group'), { code: 'ESRCH' }); });
  const rejected = assert.rejects(f.promise, error => error.name === 'AbortError');
  f.controller.abort(); f.close();
  const escalation = f.timers.find(timer => timer.ms === 5000), probe = f.intervals[0];
  missing = true; probe.callback(); await rejected;
  assert.equal(escalation.cleared, true); assert.equal(probe.cleared, true);
  missing = false;
  // Even callbacks already queued before cancellation may never target a group
  // that has since reappeared under this numeric identifier.
  escalation.callback(); probe.callback();
  assert.deepEqual(f.signals, [{ pid: -424242, name: 'SIGTERM' }, { pid: -424242, name: 0 }]);
  assert.deepEqual(f.directKills, []); assert.deepEqual(f.activity, ['run_started', 'run_stopped']);
});

test('initial ESRCH does not schedule escalation or fall back to a reaped parent id', posix, async t => {
  const f = fixture(t, () => { throw Object.assign(Error('Gone'), { code: 'ESRCH' }); });
  const rejected = assert.rejects(f.promise, error => error.name === 'AbortError');
  f.controller.abort(); f.close(); await rejected;
  assert.equal(f.timers.filter(timer => timer.ms === 5000).length, 0);
  assert.equal(f.intervals.length, 0); assert.deepEqual(f.directKills, []);
  assert.deepEqual(f.signals, [{ pid: -424242, name: 'SIGTERM' }]);
});

test('uncertain group probing cannot cancel the bounded Stop escalation', posix, async t => {
  const f = fixture(t, (_pid, name) => { if (name === 0) throw Object.assign(Error('Not observable'), { code: 'EPERM' }); });
  const rejected = assert.rejects(f.promise, error => error.name === 'AbortError');
  f.controller.abort(); f.close(); f.intervals[0].callback();
  const escalation = f.timers.find(timer => timer.ms === 5000);
  assert.equal(escalation.cleared, false); escalation.callback(); await rejected;
  assert.deepEqual(f.signals.map(signal => signal.name), ['SIGTERM', 0, 'SIGKILL']);
  assert.deepEqual(f.directKills, []);
});

test('normal completion creates no Stop obligation and no delayed group signal', posix, async t => {
  const f = fixture(t);
  f.child.stdout.write(`${JSON.stringify({ type: 'result', is_error: false })}\n`);
  f.close();
  assert.equal((await f.promise).completed, true);
  assert.equal(f.timers.filter(timer => timer.ms === 5000).length, 0); assert.equal(f.intervals.length, 0);
  assert.deepEqual(f.signals, []); assert.deepEqual(f.activity, ['run_started', 'run_finished']);
});

test('a failed spawn without a pid keeps its original error and never signals a group', posix, async t => {
  const f = fixture(t, undefined, { pid: undefined }), failure = Object.assign(Error('Executable missing'), { code: 'ENOENT' });
  const rejected = assert.rejects(f.promise, error => error === failure);
  // The injected child intentionally models the event ordering; no subprocess
  // is created. Without Stop, neither the old nor new path may signal anything.
  f.child.emit('error', failure); f.child.emit('close', -2, null);
  await rejected;
  assert.deepEqual(f.signals, []); assert.deepEqual(f.directKills, []);
  assert.equal(f.timers.filter(timer => timer.ms === 5000).length, 0);
});
