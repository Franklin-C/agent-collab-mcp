import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { codexSessionDates, createCodexUsageNormalizer, createCodexCheckpointReader } from '../bin/codex-usage.mjs';
import { createUsageCollector } from '../bin/usage.mjs';
import { runClient } from '../bin/client-adapters.mjs';

const sessionId = '01a08354-4c9d-7c90-becb-39b58bc8ca35';
const total = (input_tokens, output_tokens, cached_input_tokens) => ({ input_tokens, output_tokens, cached_input_tokens });
const totals = total(450005, 2707, 410496);
const started = { type: 'thread.started', thread_id: sessionId };
const completed = usage => ({ type: 'turn.completed', usage });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'codex-usage-')), home = join(root, 'home'), cwd = join(root, 'work');
  const directory = join(home, 'sessions', codexSessionDates(sessionId)[1]);
  mkdirSync(directory, { recursive: true }); mkdirSync(cwd);
  const path = join(directory, `rollout-2026-09-08T19-22-15-${sessionId}.jsonl`);
  const metadata = { type: 'session_meta', payload: { session_id: sessionId, id: sessionId, cwd, source: 'exec', cli_version: '0.153.4', base_instructions: 'PRIVATE PROMPT' } };
  const row = counters => ({ type: 'event_msg', timestamp: '2026-09-08T23:24:46.187Z', payload: { type: 'token_count', info: { total_token_usage: { ...counters, total_tokens: counters.input_tokens + counters.output_tokens, reasoning_output_tokens: 36 }, last_token_usage: { input_tokens: 42 } } } });
  const save = (counters = totals, extra = '') => writeFileSync(path, `${JSON.stringify(metadata)}\n${JSON.stringify(row(counters))}\n${extra}`);
  const append = counters => appendFileSync(path, `${JSON.stringify(row(counters))}\n`);
  save(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { cwd, env: { CODEX_HOME: home } }, read = createCodexCheckpointReader(options);
  return { root, home, cwd, path, directory, metadata, row, save, append, options, read };
}
async function normalizer(f, options = {}) {
  const events = [];
  const meter = await createCodexUsageNormalizer({ ...f.options, onUsage: event => { events.push(event); }, ...options });
  await meter.observe(started);
  return { meter, events };
}

test('async reader returns only exact-session counters from the observed native schema', async t => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'rollout-unrelated-session.jsonl'), 'NOT JSON: PRIVATE OTHER SESSION');
  const result = await f.read(sessionId);
  assert.deepEqual(result, { sessionId, reportedAt: '2026-09-08T23:24:46.187Z', totals });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|last_token_usage|reasoning_output_tokens|cwd/);
});

test('partial records, including parseable JSON without newline, are not committed usage', async t => {
  const f = fixture(t), next = total(450105, 2727, 410546), line = JSON.stringify(f.row(next));
  f.save(totals, line.slice(0, 20));
  assert.deepEqual((await f.read(sessionId)).totals, totals);
  appendFileSync(f.path, line.slice(20));
  assert.deepEqual((await f.read(sessionId)).totals, totals);
  appendFileSync(f.path, '\n');
  assert.deepEqual((await f.read(sessionId)).totals, next);
  appendFileSync(f.path, 'malformed\n');
  await assert.rejects(f.read(sessionId), /malformed complete/);
});

test('fresh file absence and initial metadata partial writes can be retried', async t => {
  const f = fixture(t); unlinkSync(f.path);
  assert.equal(await f.read(sessionId), null);
  const metadata = JSON.stringify(f.metadata);
  writeFileSync(f.path, metadata.slice(0, 12)); assert.equal(await f.read(sessionId), null);
  appendFileSync(f.path, metadata.slice(12) + '\n'); assert.equal(await f.read(sessionId), null);
  f.append(totals); assert.deepEqual((await f.read(sessionId)).totals, totals);
});

test('session, source, workspace, size and counter guards reject invalid evidence', async t => {
  const f = fixture(t), other = join(f.root, 'other'); mkdirSync(other);
  for (const mismatch of [{ id: 'different' }, { session_id: 'different' }, { source: 'interactive' }, { cwd: other }]) {
    writeFileSync(f.path, JSON.stringify({ ...f.metadata, payload: { ...f.metadata.payload, ...mismatch } }) + '\n' + JSON.stringify(f.row(totals)) + '\n');
    await assert.rejects(createCodexCheckpointReader(f.options)(sessionId), /exact exec session and workspace/);
  }
  f.save(); await assert.rejects(createCodexCheckpointReader({ ...f.options, maxBytes: 10 })(sessionId), /read bound/);
  for (const invalid of [total(-1, 10, 0), total(10, 10, 11), total(Number.MAX_SAFE_INTEGER, 1, 0)]) {
    f.save(invalid); await assert.rejects(createCodexCheckpointReader(f.options)(sessionId), /invalid/);
  }
  f.save(); f.append(total(450004, 2707, 410496));
  await assert.rejects(createCodexCheckpointReader(f.options)(sessionId), /regressed/);
  await assert.rejects(createCodexCheckpointReader(f.options)('../not-a-session'), error => error.code === 'CODEX_USAGE_UNAVAILABLE');
});

test('aliased directories, linked files and ambiguous exact-session candidates fail closed', async t => {
  const f = fixture(t), second = join(f.directory, `rollout-2026-09-08T20-22-15-${sessionId}.jsonl`);
  writeFileSync(second, readFileSync(f.path)); await assert.rejects(f.read(sessionId), /ambiguous/); unlinkSync(second);
  const target = join(f.root, 'hardlink.jsonl'); linkSync(f.path, target);
  await assert.rejects(f.read(sessionId), /linked/); unlinkSync(target);
  const alias = join(f.root, 'alias'); symlinkSync(f.home, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createCodexCheckpointReader({ ...f.options, env: { CODEX_HOME: alias } })(sessionId), /unaliased/);
});

for (const change of ['missing', 'replaced', 'truncated', 'rewritten']) {
  test(`an observed file cannot become ${change} even when stdout completes`, async t => {
    const f = fixture(t), { meter } = await normalizer(f);
    await meter.sample(); const original = readFileSync(f.path);
    if (change === 'missing') unlinkSync(f.path);
    if (change === 'replaced') { renameSync(f.path, join(f.root, 'retained')); writeFileSync(f.path, original); }
    if (change === 'truncated') writeFileSync(f.path, original.subarray(0, 10));
    if (change === 'rewritten') writeFileSync(f.path, original.toString().replace('PRIVATE PROMPT', 'CHANGED PROMPT'));
    await meter.observe(completed(totals));
    await assert.rejects(meter.finish({ completed: true }), error => error.code === 'CODEX_USAGE_UNAVAILABLE');
  });
}

test('native snapshots overlap final stdout exactly without adding a second bill', async t => {
  const f = fixture(t); f.save(total(100, 20, 50));
  const { meter, events } = await normalizer(f);
  await meter.sample(); await meter.sample();
  f.append(totals); await meter.sample();
  await meter.observe(completed(totals)); await meter.finish({ completed: true }); await meter.finish({ completed: true });
  assert.equal(events.length, 2); assert.deepEqual(events.at(-1).usage, totals);
  assert.notEqual(events[0].event_id, events[1].event_id);
  const collect = createUsageCollector('codex', 'gpt-test');
  assert.equal(collect(events[0])[0].cumulative, true); assert.deepEqual(collect(events[0]), []);
  assert.equal(collect(events[1])[0].input_tokens, totals.input_tokens);
});

test('lagging channels are ignored until caught up; incomparable counters pause', async t => {
  const f = fixture(t); f.save(total(100, 20, 50));
  const { meter, events } = await normalizer(f);
  await meter.observe(completed(total(200, 40, 100))); await meter.sample();
  f.append(total(200, 40, 100)); await meter.sample();
  await meter.finish({ completed: true }); assert.equal(events.length, 1);
  const other = await normalizer(f);
  await other.meter.sample();
  await assert.rejects(other.meter.observe(completed(total(300, 30, 150))), /incomparable/);
  await assert.rejects(other.meter.finish(), error => error.code === 'CODEX_USAGE_UNAVAILABLE');
});

test('fresh final stdout can exceed a lagging native checkpoint without billing the overlap twice', async t => {
  const f = fixture(t); f.save(total(100, 20, 50));
  const { meter, events } = await normalizer(f); await meter.sample();
  await meter.observe(completed(total(120, 24, 60)));
  await meter.finish({ completed: true });
  assert.deepEqual(events.map(event => event.usage), [total(100, 20, 50), total(120, 24, 60)]);
});

test('distinct ID-less turns add while stable duplicate stdout IDs do not', async t => {
  const f = fixture(t); f.save(total(300, 60, 150));
  const { meter, events } = await normalizer(f), first = { ...completed(total(100, 20, 50)), event_id: 'turn-one' };
  await meter.observe(first); await meter.observe(first);
  await meter.observe(completed(total(100, 20, 50))); await meter.observe(completed(total(100, 20, 50)));
  await meter.finish({ completed: true }); assert.equal(events.length, 3);
  assert.deepEqual(events.at(-1).usage, total(300, 60, 150));
});

test('successful fresh stdout remains sufficient when no checkpoint ever appears', async t => {
  const f = fixture(t); unlinkSync(f.path);
  const { meter, events } = await normalizer(f); await meter.sample();
  await meter.observe(completed(totals)); await meter.finish({ completed: true });
  assert.equal(events.length, 1); assert.deepEqual(events[0].usage, totals);
});

test('explicit resume subtracts a pre-spawn baseline and pauses ambiguous stdout semantics', async t => {
  const f = fixture(t), delta = total(100, 20, 50);
  const { meter, events } = await normalizer(f, { sessionId });
  f.append(total(totals.input_tokens + 100, totals.output_tokens + 20, totals.cached_input_tokens + 50));
  await meter.sample(); await meter.observe(completed(delta)); await meter.finish({ completed: true });
  assert.equal(events.length, 1); assert.deepEqual(events[0].usage, delta);
  const second = await normalizer(f, { sessionId });
  f.append(total(totals.input_tokens + 200, totals.output_tokens + 40, totals.cached_input_tokens + 100));
  await second.meter.sample(); await second.meter.observe(completed(totals));
  await assert.rejects(second.meter.finish({ completed: true }), /not reconciled|do not agree|baseline/);
  assert.deepEqual(second.events.map(event => event.usage), [delta], 'historical stdout never becomes a bill');
  unlinkSync(f.path); await assert.rejects(normalizer(f, { sessionId }), /baseline is required/);
});

test('native regression, session identity changes and failed durable sinks remain fatal', async t => {
  const f = fixture(t), { meter } = await normalizer(f);
  await assert.rejects(meter.observe({ ...started, thread_id: '01a08354-4c9d-7c90-becb-39b58bc8ca36' }), /changed session/);
  const failing = await normalizer(f, { onUsage: () => { throw new Error('disk failed'); } });
  await assert.rejects(failing.meter.sample(), /disk failed/);
  await assert.rejects(failing.meter.finish(), error => error.code === 'CODEX_USAGE_UNAVAILABLE');
  let value = totals;
  const regression = await normalizer(f, { readCheckpoint: async () => ({ totals: value }) });
  await regression.meter.sample(); value = total(100, 20, 50);
  await assert.rejects(regression.meter.sample(), /regressed/);
});

test('samples and final drain serialize behind asynchronous reads and durable delivery', async t => {
  const f = fixture(t); let active = 0, maxActive = 0, calls = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  const { meter, events } = await normalizer(f, { readCheckpoint: async () => {
    calls++; active++; maxActive = Math.max(active, maxActive); if (calls === 1) await held; active--; return { totals };
  } });
  const sample = meter.sample(), stdout = meter.observe(completed(totals)), end = meter.finish({ completed: true });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  release(); await Promise.all([sample, stdout, end]);
  assert.equal(maxActive, 1); assert.equal(calls, 2); assert.equal(events.length, 1);
});

test('a stalled checkpoint read bounds finalization and latches out late totals', { timeout: 1500 }, async t => {
  const f = fixture(t); let release, reads = 0;
  const never = new Promise(resolve => { release = resolve; });
  const { meter, events } = await normalizer(f, { readTimeoutMs: 30, readCheckpoint: () => { reads++; return never; } });
  const begin = performance.now();
  const sample = assert.rejects(meter.sample(), error => error.code === 'CODEX_USAGE_UNAVAILABLE' && /deadline/.test(error.message));
  const finish = assert.rejects(meter.finish(), error => error.code === 'CODEX_USAGE_UNAVAILABLE');
  await Promise.all([sample, finish]); assert(performance.now() - begin < 1000);
  release({ totals }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1); assert.deepEqual(events, []);
  await assert.rejects(meter.finish(), error => error.code === 'CODEX_USAGE_UNAVAILABLE');
});

test('a stalled pre-spawn resume baseline respects cancellation and its deadline', { timeout: 1500 }, async t => {
  const f = fixture(t), controller = new AbortController(); let release;
  const pending = new Promise(resolve => { release = resolve; });
  const result = normalizer(f, { sessionId, signal: controller.signal, readCheckpoint: () => pending });
  controller.abort(); await assert.rejects(result, error => error.name === 'AbortError' && error.retryable === false);
  release({ totals });
  await assert.rejects(normalizer(f, { sessionId, readTimeoutMs: 20, readCheckpoint: () => new Promise(() => {}) }), error => error.code === 'CODEX_USAGE_UNAVAILABLE' && /deadline/.test(error.message));
});

test('sanitized counters from eleven actual Codex 0.153.4 sessions reconcile exactly', async t => {
  const f = fixture(t), sessions = JSON.parse(readFileSync(new URL('./fixtures/codex-provider-counters.json', import.meta.url)));
  const sum = total(0, 0, 0); let snapshots = 0;
  assert.equal(sessions.length, 11);
  for (const session of sessions) {
    let value;
    const { meter, events } = await normalizer(f, { readCheckpoint: async () => value ? { totals: value } : null });
    for (const row of session.checkpoints) { value = total(...row); await meter.sample(); await meter.sample(); }
    if (session.completed) await meter.observe(completed(value));
    await meter.finish({ completed: session.completed });
    assert.deepEqual(events.at(-1).usage, value);
    for (const field of Object.keys(sum)) sum[field] += events.at(-1).usage[field];
    snapshots += events.length;
  }
  assert.deepEqual(sum, total(3364815, 18096, 2985472));
  assert.equal(snapshots, 91);
});

async function childRun(t, { complete = false, abort = false, invalidCheckpoint = false, absentCheckpoint = false, live = false } = {}) {
  const f = fixture(t), executable = join(f.root, 'client.cjs'), controller = new AbortController(), reports = [], activity = [];
  if (invalidCheckpoint) writeFileSync(f.path, '{}\n');
  if (absentCheckpoint) unlinkSync(f.path);
  writeFileSync(executable, `console.log(JSON.stringify(${JSON.stringify(started)})); ${complete ? `setTimeout(()=>{console.log(JSON.stringify(${JSON.stringify(completed(totals))}));},${live ? 250 : 0});` : ''} ${abort ? 'setInterval(()=>{},1000);' : `process.exitCode=${complete ? 0 : 1};`}`);
  const collect = createUsageCollector('codex', 'gpt-test'); let beforeCompletion = false;
  const result = runClient({ client: 'codex', executable: process.execPath }, 'PRIVATE PROMPT', { cwd: f.cwd, env: { ...process.env, ...f.options.env }, model: 'gpt-test', signal: controller.signal, timeoutMs: 3000, usagePollMs: 20,
    spawn: (_command, _args, options) => spawn(process.execPath, [executable], options),
    onOutput: chunk => { if (abort && !live) setTimeout(() => controller.abort(), 20); if (String(chunk).includes('turn.completed')) beforeCompletion = true; },
    onUsage: raw => { reports.push(...collect(raw)); if (live) assert.equal(beforeCompletion, false); if (abort && live) controller.abort(); }, onActivity: event => activity.push(event),
  });
  return { result, reports, activity };
}

test('actual child interruption emits provider totals and still rejects cancellation', async t => {
  const child = await childRun(t, { abort: true });
  await assert.rejects(child.result, error => error.name === 'AbortError' && error.usageRecoveryError === undefined);
  assert.equal(child.reports.length, 1); assert.equal(child.reports[0].input_tokens, totals.input_tokens); assert.equal(child.reports[0].cumulative, true);
  assert(child.activity.some(event => event.kind === 'usage_reported' && event.usageScope === 'run'));
  assert.equal(child.activity.at(-1).kind, 'run_stopped'); assert.doesNotMatch(JSON.stringify(child.reports), /PRIVATE|rollout|base_instructions/);
});

for (const absentCheckpoint of [false, true]) test(`normal completed child reports once (checkpoint absent: ${absentCheckpoint})`, async t => {
  const child = await childRun(t, { complete: true, absentCheckpoint }); await child.result;
  assert.equal(child.reports.length, 1); assert.equal(child.reports[0].cumulative, true);
  assert.equal(child.activity.filter(event => event.kind === 'usage_reported').length, 1);
});

test('a running child reports native usage before final stdout without duplicate final accounting', async t => {
  const child = await childRun(t, { complete: true, live: true }); await child.result;
  assert.equal(child.reports.length, 1);
});

test('Stop from delivered live usage cancels the running child and final sampling stays passive', async t => {
  const child = await childRun(t, { abort: true, live: true });
  await assert.rejects(child.result, error => error.name === 'AbortError' && !error.usageRecoveryError);
  assert.equal(child.reports.length, 1); assert.equal(child.activity.at(-1).kind, 'run_stopped');
});

test('unavailable interrupted usage is explicit and never estimated', async t => {
  const child = await childRun(t, { invalidCheckpoint: true });
  await assert.rejects(child.result, error => error.code === 'CODEX_USAGE_UNAVAILABLE' && /no token estimate/.test(error.usageRecoveryError));
  assert.deepEqual(child.reports, []);
});
