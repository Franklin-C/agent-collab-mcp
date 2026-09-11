import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClient } from '../bin/client-adapters.mjs';
import { createCodexCheckpointReader, createCodexUsageNormalizer } from '../bin/codex-usage.mjs';
const sessionId = '01a08a86-95c6-7e90-8bed-46d6ab6c55a0';
const terminal = { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'prior-or-current-fixture-turn', error: { codex_error_info: 'other', message: JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again." } }) } } };
const record = value => JSON.stringify(value) + '\n';
const usageRecord = input => ({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: 2, cached_input_tokens: 0 } } } });

function fixture(t, events = [terminal]) {
  const root = mkdtempSync(join(tmpdir(), 'ehgi-native-diagnostic-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), cwd = join(root, 'repo'), day = join(home, 'sessions', '2026', '09', '10');
  mkdirSync(day, { recursive: true }); mkdirSync(cwd);
  const meta = { type: 'session_meta', payload: { id: sessionId, session_id: sessionId, source: 'exec', cwd } };
  const file = join(day, `rollout-2026-09-10T04-54-31-${sessionId}.jsonl`);
  writeFileSync(file, [meta, ...events].map(record).join(''));
  const reports = [], diagnostics = [];
  return { root, home, cwd, file, day, meta, reports, diagnostics, options: { cwd, env: { CODEX_HOME: home }, onUsage: event => reports.push(event), onDiagnostic: kind => diagnostics.push(kind) } };
}

function fakeSpawn() {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  queueMicrotask(() => {
    // The actual failure need not also appear on stdout: only session identity.
    child.stdout.write(record({ type: 'thread.started', thread_id: sessionId }));
    child.stdout.end(); child.stderr.end(); child.emit('exit', 1, null); child.emit('close', 1, null);
  });
  return child;
}

test('native-only observed terminal rejection reaches actual adapter while unknown usage remains paused', async t => {
  const f = fixture(t), activity = [];
  await assert.rejects(runClient({ client: 'codex', executable: 'never-launched' }, 'fixture', { ...f.options, spawn: fakeSpawn, onActivity: event => activity.push(event), timeoutMs: 1000 }), error => {
    assert.equal(error.code, 'CODEX_USAGE_UNAVAILABLE'); assert.equal(error.retryable, false);
    assert.equal(error.requiresUpdate, true); assert.match(error.message, /newer Codex CLI/);
    assert.match(error.usageRecoveryError, /no token estimate/);
    assert(!error.message.includes('gpt-6-astra')); return true;
  });
  assert.deepEqual(f.reports, []); assert.equal(activity.at(-1).kind, 'run_failed');
  assert(!JSON.stringify(activity).includes('invalid_request_error'));
});

test('reader keeps counter return contract and emits only one fixed diagnostic after validated read', async t => {
  const f = fixture(t), read = createCodexCheckpointReader(f.options);
  assert.equal(await read(sessionId, { onDiagnostic: f.options.onDiagnostic }), null);
  assert.deepEqual(f.diagnostics, ['codex_update_required']);
  assert.equal(await read(sessionId, { onDiagnostic: f.options.onDiagnostic }), null);
  assert.deepEqual(f.diagnostics, ['codex_update_required']);
});

test('a native rejection cannot emit a successful activity even if stdout completes with real counters', async t => {
  const f = fixture(t, [usageRecord(10), terminal]), activity = [];
  const spawn = () => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stdout.write(record({ type: 'thread.started', thread_id: sessionId }));
      child.stdout.write(record({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0 } }));
      child.stdout.end(); child.stderr.end(); child.emit('exit', 0, null); child.emit('close', 0, null);
    });
    return child;
  };
  await assert.rejects(runClient({ client: 'codex', executable: 'never-launched' }, 'fixture', { ...f.options, spawn, onActivity: event => activity.push(event) }), error => error.code === 'CLIENT_UPDATE_REQUIRED');
  assert.equal(activity.at(-1).kind, 'run_failed'); assert(!activity.some(event => event.kind === 'run_finished'));
  assert.equal(f.reports.length, 1); assert.deepEqual(f.reports[0].usage, { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0 });
});

for (const mode of ['metadata', 'malformed-tail', 'invalid-counter', 'ambiguous', 'oversized']) test(`no diagnostic escapes rejected native evidence: ${mode}`, async t => {
  const f = fixture(t);
  if (mode === 'metadata') writeFileSync(f.file, record({ ...f.meta, payload: { ...f.meta.payload, id: 'wrong-session' } }) + record(terminal));
  if (mode === 'malformed-tail') appendFileSync(f.file, '{invalid}\n');
  if (mode === 'invalid-counter') appendFileSync(f.file, record(usageRecord(-1)));
  if (mode === 'ambiguous') writeFileSync(join(f.day, `rollout-2026-09-10T05-00-00-${sessionId}.jsonl`), readFileSync(f.file));
  const read = createCodexCheckpointReader({ ...f.options, ...(mode === 'oversized' ? { maxBytes: 1 } : {}) });
  await assert.rejects(read(sessionId, { onDiagnostic: f.options.onDiagnostic }), error => error.code === 'CODEX_USAGE_UNAVAILABLE');
  assert.deepEqual(f.diagnostics, []);
});

test('a partial snapshot supplies no hint until its complete records are safely committed', async t => {
  const f = fixture(t, []), read = createCodexCheckpointReader(f.options);
  appendFileSync(f.file, JSON.stringify(terminal));
  assert.equal(await read(sessionId, { onDiagnostic: f.options.onDiagnostic }), null);
  assert.deepEqual(f.diagnostics, []);
  appendFileSync(f.file, '\n{"type":"event_msg"');
  assert.equal(await read(sessionId, { onDiagnostic: f.options.onDiagnostic }), null);
  assert.deepEqual(f.diagnostics, []);
  appendFileSync(f.file, ',"payload":{"type":"unrelated"}}\n');
  assert.equal(await read(sessionId, { onDiagnostic: f.options.onDiagnostic }), null);
  assert.deepEqual(f.diagnostics, ['codex_update_required']);
});

test('rewriting previously validated bytes cannot supply a new hint', async t => {
  const f = fixture(t, []), read = createCodexCheckpointReader(f.options);
  await read(sessionId, { onDiagnostic: f.options.onDiagnostic });
  const previous = readFileSync(f.file, 'utf8');
  writeFileSync(f.file, previous.replace('"exec"', '"chat"') + record(terminal));
  await assert.rejects(read(sessionId, { onDiagnostic: f.options.onDiagnostic }), error => error.code === 'CODEX_USAGE_UNAVAILABLE');
  assert.deepEqual(f.diagnostics, []);
});

test('a resumed baseline consumes old terminal errors without labeling the new invocation', async t => {
  const f = fixture(t, [usageRecord(10), terminal]);
  const meter = await createCodexUsageNormalizer({ ...f.options, sessionId });
  assert.deepEqual(f.diagnostics, []);
  await meter.sample();
  appendFileSync(f.file, record(usageRecord(13)));
  await meter.observe({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 0, cached_input_tokens: 0 } });
  await meter.finish({ completed: true });
  assert.deepEqual(f.diagnostics, []); assert.equal(f.reports.length, 1);
  assert.deepEqual(f.reports[0].usage, { input_tokens: 3, output_tokens: 0, cached_input_tokens: 0 });
});

test('a new terminal version error after the resume baseline can supply the typed hint', async t => {
  const f = fixture(t, [usageRecord(10), terminal]);
  const meter = await createCodexUsageNormalizer({ ...f.options, sessionId });
  appendFileSync(f.file, record(usageRecord(13)) + record({ ...terminal, payload: { ...terminal.payload, turn_id: 'new-fixture-turn' } }));
  await meter.finish({ completed: false });
  assert.deepEqual(f.diagnostics, ['codex_update_required']);
  assert.deepEqual(f.reports[0].usage, { input_tokens: 3, output_tokens: 0, cached_input_tokens: 0 });
});

test('a terminal record begun before the resume baseline cannot become a fresh hint when completed later', async t => {
  const f = fixture(t, [usageRecord(10)]), text = JSON.stringify(terminal);
  appendFileSync(f.file, text.slice(0, -5));
  const meter = await createCodexUsageNormalizer({ ...f.options, sessionId });
  appendFileSync(f.file, text.slice(-5) + '\n' + record(usageRecord(13)));
  await meter.observe({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 0, cached_input_tokens: 0 } });
  await meter.finish({ completed: true });
  assert.deepEqual(f.diagnostics, []);
  assert.deepEqual(f.reports[0].usage, { input_tokens: 3, output_tokens: 0, cached_input_tokens: 0 });
});

test('a timed-out read never forwards a late hint or invents usage', async t => {
  const f = fixture(t); let completeRead, callback;
  const meter = await createCodexUsageNormalizer({ ...f.options, readTimeoutMs: 15, readCheckpoint: (_id, options) => {
    callback = options?.onDiagnostic; return new Promise(resolve => { completeRead = resolve; });
  } });
  await meter.observe({ type: 'thread.started', thread_id: sessionId });
  await assert.rejects(meter.finish({ completed: false }), error => error.code === 'CODEX_USAGE_UNAVAILABLE');
  callback?.('codex_update_required'); completeRead(null);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.diagnostics, []); assert.deepEqual(f.reports, []);
});

test('a hint staged before a failing read is never forwarded', async t => {
  const f = fixture(t);
  const meter = await createCodexUsageNormalizer({ ...f.options, readCheckpoint: async (_id, options) => {
    options?.onDiagnostic?.('codex_update_required'); throw Object.assign(new Error('read became invalid'), { code: 'CODEX_USAGE_UNAVAILABLE', retryable: false });
  } });
  await meter.observe({ type: 'thread.started', thread_id: sessionId });
  await assert.rejects(meter.finish({ completed: false }), error => error.code === 'CODEX_USAGE_UNAVAILABLE');
  assert.deepEqual(f.diagnostics, []); assert.deepEqual(f.reports, []);
});
