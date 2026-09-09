import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { codexSessionDates, createCodexUsageRecovery, readCodexUsageCheckpoint } from '../bin/codex-usage.mjs';
import { createUsageCollector } from '../bin/usage.mjs';
import { runClient } from '../bin/client-adapters.mjs';

const sessionId = '01a08354-4c9d-7c90-becb-39b58bc8ca35';
const totals = { input_tokens: 450005, output_tokens: 2707, cached_input_tokens: 410496 };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'codex-usage-')), home = join(root, 'home'), cwd = join(root, 'work');
  const date = codexSessionDates(sessionId)[1], directory = join(home, 'sessions', date);
  mkdirSync(directory, { recursive: true }); mkdirSync(cwd);
  const path = join(directory, `rollout-2026-09-08T19-22-15-${sessionId}.jsonl`);
  const metadata = { type: 'session_meta', timestamp: '2026-09-08T23:22:15.564Z', payload: { session_id: sessionId, id: sessionId, cwd, source: 'exec', cli_version: '0.153.4', base_instructions: 'PRIVATE PROMPT' } };
  const row = counters => ({ type: 'event_msg', timestamp: '2026-09-08T23:24:46.187Z', payload: { type: 'token_count', info: { total_token_usage: { ...counters, total_tokens: counters.input_tokens + counters.output_tokens, reasoning_output_tokens: 36 }, last_token_usage: { input_tokens: 42 } } } });
  const save = (counters = totals, extra = '') => writeFileSync(path, `${JSON.stringify(metadata)}\n${JSON.stringify(row(counters))}\n${extra}`);
  save(); t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, home, cwd, path, directory, metadata, row, save, options: { sessionId, cwd, env: { CODEX_HOME: home } } };
}

test('reads only exact-session provider totals from the observed native schema', t => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'rollout-unrelated-session.jsonl'), 'NOT JSON: PRIVATE OTHER SESSION');
  const result = readCodexUsageCheckpoint(f.options);
  assert.deepEqual(result, { sessionId, reportedAt: '2026-09-08T23:24:46.187Z', totals });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|last_token_usage|reasoning_output_tokens|cwd/);
});

test('partial final writes preserve the last complete checkpoint; malformed complete records do not', t => {
  const f = fixture(t); f.save(totals, '{"type":"event_msg"');
  assert.deepEqual(readCodexUsageCheckpoint(f.options).totals, totals);
  f.save(totals, 'malformed\n'); assert.throws(() => readCodexUsageCheckpoint(f.options), /malformed complete/);
});

test('session, source, workspace, file size and monotonicity must all match', t => {
  const f = fixture(t), other = join(f.root, 'other'); mkdirSync(other);
  for (const mismatch of [{ id: 'different' }, { session_id: 'different' }, { source: 'interactive' }, { cwd: other }]) {
    writeFileSync(f.path, JSON.stringify({ ...f.metadata, payload: { ...f.metadata.payload, ...mismatch } }) + '\n' + JSON.stringify(f.row(totals)) + '\n');
    assert.throws(() => readCodexUsageCheckpoint(f.options), /exact exec session and workspace/);
  }
  f.save(); assert.throws(() => readCodexUsageCheckpoint({ ...f.options, maxBytes: 10 }), /read bound/);
  f.save(totals, JSON.stringify(f.row({ ...totals, input_tokens: totals.input_tokens - 1 })) + '\n');
  assert.throws(() => readCodexUsageCheckpoint(f.options), /regressed/);
  assert.throws(() => readCodexUsageCheckpoint({ ...f.options, sessionId: '../not-a-session' }), error => error.code === 'CODEX_USAGE_UNAVAILABLE');
});

test('aliased directories, linked files and ambiguous exact-session candidates fail closed', t => {
  const f = fixture(t), second = join(f.directory, `rollout-2026-09-08T20-22-15-${sessionId}.jsonl`);
  writeFileSync(second, readFileSync(f.path)); assert.throws(() => readCodexUsageCheckpoint(f.options), /ambiguous/); unlinkSync(second);
  const target = join(f.root, 'hardlink.jsonl'); linkSync(f.path, target);
  assert.throws(() => readCodexUsageCheckpoint(f.options), /linked/); unlinkSync(target);
  const alias = join(f.root, 'alias'); symlinkSync(f.home, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readCodexUsageCheckpoint({ ...f.options, env: { CODEX_HOME: alias } }), /unaliased/);
});

test('fresh interruption reports checkpoint totals once without fabricating completion', t => {
  const f = fixture(t), recovery = createCodexUsageRecovery({ cwd: f.cwd, env: f.options.env });
  recovery.observe({ type: 'thread.started', thread_id: sessionId });
  const event = recovery.recover();
  assert.equal(event.type, 'ehgi.codex_usage_recovery'); assert.deepEqual(event.usage, totals);
  assert.deepEqual(event.run_usage, totals); assert.equal(recovery.recover(), null);
  const collect = createUsageCollector('codex', 'gpt-test');
  assert.equal(collect(event)[0].input_tokens, totals.input_tokens); assert.deepEqual(collect(event), []);
});

test('stdout completion and exact checkpoint equality add no second usage report', t => {
  const f = fixture(t), recovery = createCodexUsageRecovery({ cwd: f.cwd, env: f.options.env });
  recovery.observe({ type: 'thread.started', thread_id: sessionId });
  recovery.observe({ type: 'turn.completed', usage: totals });
  assert.equal(recovery.recover(), null);
});

test('an interrupted later turn recovers only unreported deltas, not earlier stdout totals', t => {
  const f = fixture(t), recovery = createCodexUsageRecovery({ cwd: f.cwd, env: f.options.env });
  const first = { input_tokens: 100, output_tokens: 20, cached_input_tokens: 50 };
  recovery.observe({ type: 'thread.started', thread_id: sessionId });
  recovery.observe({ type: 'turn.completed', event_id: 'first', usage: first });
  recovery.observe({ type: 'turn.completed', event_id: 'first', usage: first });
  recovery.observe({ type: 'turn.completed', usage: first });
  const event = recovery.recover();
  assert.deepEqual(event.usage, { input_tokens: totals.input_tokens - 200, output_tokens: totals.output_tokens - 40, cached_input_tokens: totals.cached_input_tokens - 100 });
  assert.deepEqual(event.run_usage, totals);
});

test('resume snapshots the prior counters before execution and rejects missing baseline or session changes', t => {
  const f = fixture(t), recovery = createCodexUsageRecovery(f.options);
  recovery.observe({ type: 'thread.started', thread_id: sessionId });
  f.save({ input_tokens: totals.input_tokens + 100, output_tokens: totals.output_tokens + 20, cached_input_tokens: totals.cached_input_tokens + 50 });
  assert.deepEqual(recovery.recover().usage, { input_tokens: 100, output_tokens: 20, cached_input_tokens: 50 });
  const changed = createCodexUsageRecovery(f.options); changed.observe({ type: 'thread.started', thread_id: '01a08354-4c9d-7c90-becb-39b58bc8ca36' });
  assert.throws(() => changed.recover(), /changed session identity/);
  unlinkSync(f.path); assert.throws(() => createCodexUsageRecovery(f.options), /baseline is required/);
});

async function childRun(t, { complete = false, abort = false, invalidCheckpoint = false } = {}) {
  const f = fixture(t), executable = join(f.root, 'client.cjs'), controller = new AbortController(), reports = [], activity = [];
  if (invalidCheckpoint) writeFileSync(f.path, '{}\n');
  writeFileSync(executable, `console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(sessionId)}})); ${complete ? `console.log(JSON.stringify({type:'turn.completed',usage:${JSON.stringify(totals)}}));` : ''} ${abort ? 'setInterval(()=>{},1000);' : `process.exitCode=${complete ? 0 : 1};`}`);
  const collect = createUsageCollector('codex', 'gpt-test');
  const result = runClient({ client: 'codex', executable: process.execPath }, 'PRIVATE PROMPT', { cwd: f.cwd, env: { ...process.env, ...f.options.env }, model: 'gpt-test', signal: controller.signal, timeoutMs: 3000,
    spawn: (_command, _args, options) => spawn(process.execPath, [executable], options),
    onOutput: () => { if (abort) setTimeout(() => controller.abort(), 20); },
    onUsage: raw => reports.push(...collect(raw)), onActivity: event => activity.push(event),
  });
  return { result, reports, activity };
}

test('actual child interruption emits recovered usage and still rejects cancellation', async t => {
  const child = await childRun(t, { abort: true });
  await assert.rejects(child.result, error => error.name === 'AbortError' && error.usageRecoveryError === undefined);
  assert.equal(child.reports.length, 1); assert.equal(child.reports[0].input_tokens, totals.input_tokens);
  assert.match(child.reports[0].note, /exact Codex session checkpoint/);
  assert(child.activity.some(event => event.kind === 'usage_reported' && event.usageScope === 'run'));
  assert.equal(child.activity.at(-1).kind, 'run_stopped');
  assert.doesNotMatch(JSON.stringify(child.reports), /PRIVATE|rollout|base_instructions/);
});

test('a normal completed child uses stdout accounting only', async t => {
  const child = await childRun(t, { complete: true }); await child.result;
  assert.equal(child.reports.length, 1); assert.equal(child.reports[0].note, undefined);
  assert.equal(child.activity.filter(event => event.kind === 'usage_reported').length, 1);
});

test('unavailable interrupted usage is explicit and never replaced with an estimate', async t => {
  const child = await childRun(t, { invalidCheckpoint: true });
  await assert.rejects(child.result, error => /no token estimate/.test(error.usageRecoveryError));
  assert.deepEqual(child.reports, []);
});
