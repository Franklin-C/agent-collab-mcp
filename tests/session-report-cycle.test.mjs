import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSessionUsageOutbox } from '../bin/session-usage-outbox.mjs';
import { createSessionReportCycle as create } from '../bin/session-report-cycle.mjs';
import { createNativeUsageDelivery } from '../bin/session-usage-delivery.mjs';

function setup(t, connectionScope = 'a'.repeat(64)) {
  const directory = mkdtempSync(join(tmpdir(), 'ehgi-report-cycle-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return createSessionUsageOutbox({ statePath: join(directory, 'usage.json'), client: 'codex', sessionId: '01a07a24-a447-75b3-890e-ceb683c31bfe', connectionScope });
}
const row = n => [{ model: 'gpt-6-astra', token_semantics: 'inclusive', input_tokens: n, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }];

test('scheduled reporting serializes starts, waits after completion and stops during its real timer', async t => {
  const controller = new AbortController(), outbox = setup(t), states = [];
  let reads = 0, wake;
  const waiting = new Promise(resolve => { wake = resolve; });
  const cycle = create({ outbox, signal: controller.signal, canReport: async () => true,
    observe: async () => { reads++; return row(100); }, deliver: async () => assert.fail('baseline must not send'), onStatus: value => states.push(value) });
  const running = cycle.run({ wait: async (ms, signal) => {
    assert.equal(ms, 30_000); assert.equal(reads, 1); assert.equal(signal, controller.signal);
    // Exercise an actual abortable Node timer, without waiting for its expiry.
    const { setTimeout } = await import('node:timers/promises');
    const timer = setTimeout(ms, undefined, { signal }); wake(); return timer;
  } });
  assert.equal(cycle.run(), running);
  await waiting; controller.abort();
  assert.deepEqual(await running, { reason: 'stopped' });
  assert.equal(reads, 1); assert.equal(states.at(-1).state, 'stopped');
});

test('scheduled reporting retries transient delivery but halts on authentication failure', async t => {
  const controller = new AbortController(), outbox = setup(t), waits = [];
  outbox.record(row(100)); outbox.record(row(110));
  let sends = 0;
  const cycle = create({ outbox, signal: controller.signal, canReport: async () => true, observe: async () => row(110),
    deliver: async () => { if (++sends === 1) throw Object.assign(new Error('offline'), { retryable: true }); throw Object.assign(new Error('auth'), { status: 401 }); } });
  assert.deepEqual(await cycle.run({ wait: async ms => waits.push(ms) }), { reason: 'paused' });
  assert.deepEqual(waits, [30_000]); assert.equal(sends, 2); assert.equal(outbox.pendingCount(), 1);
  assert.deepEqual(await cycle.run({ wait: async () => assert.fail('must stay paused') }), { reason: 'paused' });
  assert.equal(sends, 2);
});

test('scheduling requires cancellation and refuses rapid polling', async t => {
  const args = { outbox: setup(t), canReport: async () => true, observe: async () => row(100), deliver: async () => assert.fail('must not send') };
  assert.throws(() => create(args).run(), /cancellation signal/);
  const controller = new AbortController(); controller.abort();
  const cycle = create({ ...args, signal: controller.signal });
  assert.throws(() => cycle.run({ intervalMs: 1 }), /30 and 300/);
  assert.deepEqual(await cycle.run(), { reason: 'stopped' });
});

test('integrates baseline, offline retention and recovery without replaying historical usage', async t => {
  const outbox = setup(t), states = [], sent = [];
  let snapshot = row(100), offline = true;
  const cycle = create({ outbox, observe: async () => snapshot, canReport: async () => true, onStatus: value => states.push(value), deliver: async report => {
    if (offline) throw Object.assign(new Error('PRIVATE'), { retryable: true });
    sent.push(report); return { ok: true };
  } });
  await cycle.tick(); snapshot = row(110); await cycle.tick();
  assert.equal(outbox.pendingCount(), 1); assert.equal(states.at(-1).state, 'retrying');
  offline = false; await cycle.tick();
  assert.equal(sent[0].input_tokens, 10); assert.equal(outbox.pendingCount(), 0);
  assert.equal(states.at(-1).state, 'waiting'); assert(!JSON.stringify(states).includes('PRIVATE'));
});

test('Stop during the initial read prevents writes and sends, with overlapping ticks serialized', async t => {
  const controller = new AbortController(), outbox = setup(t), states = [];
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const reading = new Promise(resolve => { release = resolve; });
  const cycle = create({ outbox, signal: controller.signal, canReport: async () => true, observe: async () => { entered(); await reading; return row(100); }, deliver: async () => assert.fail('must not deliver'), onStatus: value => states.push(value) });
  const first = cycle.tick(); assert.equal(cycle.tick(), first);
  await started; controller.abort(); release(); await first;
  assert.equal(outbox.pendingCount(), 0); assert.equal(states.at(-1).state, 'stopped');
});

test('revocation before delivery retains pending usage and refuses a send', async t => {
  const outbox = setup(t), states = []; outbox.record(row(100)); outbox.record(row(110));
  let checks = 0;
  const cycle = create({ outbox, observe: async () => row(110), canReport: async () => ++checks < 3, deliver: async () => assert.fail('must not send'), onStatus: value => states.push(value) });
  await cycle.tick(); assert.equal(outbox.pendingCount(), 1); assert.equal(states.at(-1).reason, 'accounting_authority_required');
});

test('authentication failure pauses subsequent cycles without offline guesses', async t => {
  const outbox = setup(t), states = []; outbox.record(row(100)); outbox.record(row(110));
  let reads = 0;
  const cycle = create({ outbox, observe: async () => { reads++; return row(110); }, canReport: async () => true, deliver: async () => { throw Object.assign(new Error('PRIVATE'), { status: 401 }); }, onStatus: value => states.push(value) });
  await cycle.tick(); await cycle.tick();
  assert.equal(reads, 1); assert.equal(outbox.pendingCount(), 1); assert.equal(states.at(-1).reason, 'authentication_required');
  assert(!JSON.stringify(states).includes('offline'));
});

test('an unreadable observation pauses without dropping pending reports or exposing raw errors', async t => {
  const outbox = setup(t), states = []; outbox.record(row(100)); outbox.record(row(110));
  const cycle = create({ outbox, canReport: async () => true, observe: async () => { throw null; }, deliver: async () => assert.fail('must not send'), onStatus: value => states.push(value) });
  await cycle.tick();
  assert.equal(outbox.pendingCount(), 1); assert.equal(states.at(-1).reason, 'reporting_error');
});

test('Stop interrupts an in-flight HTTP upload and retains its unacknowledged report', async t => {
  const controller = new AbortController(), states = [];
  let began, calls = 0;
  const started = new Promise(resolve => { began = resolve; });
  const transport = createNativeUsageDelivery({ server: 'http://localhost', token: 'fixture-token', agentId: 'fixture-agent', source: 'client_json',
    fetch: async (_url, request) => {
      calls++; began();
      return await new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
        if (request.signal.aborted) reject(request.signal.reason);
      });
    },
  });
  const outbox = setup(t, transport.connectionScope); outbox.record(row(100)); outbox.record(row(110));
  const cycle = create({ outbox, observe: async () => row(110), canReport: async () => true, signal: controller.signal, deliver: transport.deliver, onStatus: value => states.push(value) });
  const running = cycle.tick(); await started; controller.abort(); await running;
  assert.equal(calls, 1); assert.equal(outbox.pendingCount(), 1); assert.equal(states.at(-1).state, 'stopped');
});
