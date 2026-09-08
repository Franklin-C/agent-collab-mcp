import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireWorkerLock, processIsAbsent } from '../bin/worker-lock.mjs';
import { canRetryStartup, runWithStartupRecovery } from '../bin/startup-recovery.mjs';

function fixture(t) { const state = mkdtempSync(join(tmpdir(), 'ehgi-lock-')); t.after(() => rmSync(state, { recursive: true, force: true })); return state; }
const absent = () => { throw Object.assign(new Error('absent'), { code: 'ESRCH' }); };
const oldLock = (state, patch = {}) => writeFileSync(join(state, 'worker.lock'), JSON.stringify({ version: 1, pid: 99999, nonce: '01234567-0123-0123-0123-0123456789ab', identity: 'owned', phase: 'idle', ...patch }));

test('recovers only its matching saved identity when PID absence is proved', t => {
  const state = fixture(t); oldLock(state);
  const lock = acquireWorkerLock(state, 'owned', { recoverStale: true, probe: absent });
  assert.equal(JSON.parse(readFileSync(join(state, 'worker.lock'), 'utf8')).pid, process.pid);
  lock.release(); assert.equal(existsSync(join(state, 'worker.lock')), false);
});
test('live/reused PIDs, permission errors and other identities retain their lock', t => {
  const state = fixture(t); oldLock(state); const before = readFileSync(join(state, 'worker.lock'), 'utf8');
  for (const probe of [() => {}, () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); }]) {
    assert.throws(() => acquireWorkerLock(state, 'owned', { recoverStale: true, probe }), /not removed/);
    assert.equal(readFileSync(join(state, 'worker.lock'), 'utf8'), before);
  }
  assert.throws(() => acquireWorkerLock(state, 'other', { recoverStale: true, probe: absent }), /not removed/);
});
test('legacy locks and acquisition guards never trigger automatic deletion', t => {
  const state = fixture(t); writeFileSync(join(state, 'worker.lock'), '99999');
  assert.throws(() => acquireWorkerLock(state, 'owned', { recoverStale: true, probe: absent }), /not removed|inspection/);
  writeFileSync(join(state, 'worker.lock.guard'), 'old guard');
  assert.throws(() => acquireWorkerLock(state, 'owned', { recoverStale: true, probe: absent }), /acquisition/);
  assert.equal(readFileSync(join(state, 'worker.lock'), 'utf8'), '99999');
});
test('an old release cannot remove a replacement lock', t => {
  const state = fixture(t), lock = acquireWorkerLock(state, 'owned'); oldLock(state);
  lock.release(); assert.equal(JSON.parse(readFileSync(join(state, 'worker.lock'), 'utf8')).pid, 99999);
});
test('PID probing treats only ESRCH as evidence, and rejects unsafe PID values', () => {
  assert.equal(processIsAbsent(123, absent), true);
  assert.equal(processIsAbsent(0, absent), false); assert.equal(processIsAbsent(-1, absent), false);
  assert.equal(processIsAbsent(123, () => { throw Error('unknown'); }), false);
});

test('a crashed active-client lock remains even when the worker PID is absent', t => {
  const state = fixture(t); oldLock(state, { phase: 'client_active' });
  assert.throws(() => acquireWorkerLock(state, 'owned', { recoverStale: true, probe: absent }), /interrupted during client/);
  assert.equal(JSON.parse(readFileSync(join(state, 'worker.lock'), 'utf8')).phase, 'client_active');
});

test('lock phase changes preserve ownership and legacy phase-less locks stay unverifiable', t => {
  const state = fixture(t), lock = acquireWorkerLock(state, 'owned');
  lock.setPhase('client_active'); assert.equal(lock.isOwned(), true);
  assert.equal(JSON.parse(readFileSync(join(state, 'worker.lock'), 'utf8')).phase, 'client_active');
  lock.setPhase('idle'); assert.equal(lock.ownsDirectory(state), true); lock.release();
  oldLock(state, { phase: undefined });
  assert.throws(() => acquireWorkerLock(state, 'owned', { recoverStale: true, probe: absent }), /unverifiable/);
});

test('concurrent real processes admit one lock owner and recover only after its idle process exits', async t => {
  const state = fixture(t), moduleUrl = new URL('../bin/worker-lock.mjs', import.meta.url).href;
  const script = `import { acquireWorkerLock } from ${JSON.stringify(moduleUrl)};
    process.send('ready'); process.on('message', message => {
      if (message !== 'acquire') return;
      try { const lock = acquireWorkerLock(${JSON.stringify(state)}, 'parallel', { recoverStale: true }); process.send({ acquired: true }); }
      catch (error) { process.send({ acquired: false, code: error.code }); process.disconnect(); }
    });`;
  const children = Array.from({ length: 8 }, () => spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  try {
    await Promise.all(children.map(child => once(child, 'message')));
    const results = children.map(child => once(child, 'message').then(([message]) => message));
    for (const child of children) child.send('acquire');
    const outcomes = await Promise.all(results);
    assert.equal(outcomes.filter(result => result.acquired).length, 1);
    assert.ok(outcomes.filter(result => !result.acquired).every(result => result.code === 'WORKER_LOCKED'));
    const winner = children[outcomes.findIndex(result => result.acquired)];
    const before = readFileSync(join(state, 'worker.lock'), 'utf8');
    assert.equal(JSON.parse(before).pid, winner.pid);
    assert.throws(() => acquireWorkerLock(state, 'parallel', { recoverStale: true }), { code: 'WORKER_LOCKED' });
    assert.equal(readFileSync(join(state, 'worker.lock'), 'utf8'), before);
    const exited = once(winner, 'exit'); winner.kill(); await exited;
    assert.equal(processIsAbsent(winner.pid), true);
    const recovered = acquireWorkerLock(state, 'parallel', { recoverStale: true });
    assert.equal(recovered.isOwned(), true); recovered.release();
  } finally {
    await Promise.all(children.map(async child => {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    }));
  }
});
test('transient startup exits back off and then succeed without rerunning a normal stop', async () => {
  let attempts = 0; const waits = [];
  const result = await runWithStartupRecovery(async () => { if (++attempts < 3) throw { retryable: true, status: 503 }; return { stop: true }; }, { wait: async ms => waits.push(ms) });
  assert.equal(attempts, 3); assert.deepEqual(waits, [1000, 4000]); assert.deepEqual(result, { stop: true });
});
test('persistent transport failure is bounded to three retries', async () => {
  let attempts = 0;
  await assert.rejects(runWithStartupRecovery(async () => { attempts++; throw Object.assign(Error('network'), { retryable: true }); }, { wait: async () => {} }));
  assert.equal(attempts, 4);
});
test('authorization, approval, stale leases and untyped errors never retry', async () => {
  for (const error of [{ retryable: true, status: 401 }, { retryable: true, status: 409 }, { retryable: true, requiresApproval: true }, { retryable: true, requiresAuthentication: true }, { retryable: true, code: 'WORKER_LOCKED' }, Error('unknown')]) {
    assert.equal(canRetryStartup(error), false); let attempts = 0;
    await assert.rejects(runWithStartupRecovery(async () => { attempts++; throw error; }, { wait: async () => assert.fail('unexpected wait') }));
    assert.equal(attempts, 1);
  }
});
test('Stop during backoff prevents another worker invocation', async () => {
  const controller = new AbortController(); let attempts = 0;
  const result = await runWithStartupRecovery(async () => { attempts++; throw { retryable: true }; }, { signal: controller.signal, wait: async () => controller.abort() });
  assert.equal(attempts, 1); assert.deepEqual(result, { stopped: true });
});
