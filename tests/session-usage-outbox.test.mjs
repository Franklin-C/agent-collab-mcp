import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionUsageOutbox as create } from '../bin/session-usage-outbox.mjs';

const row = n => ({ model: 'gpt-6-astra', input_tokens: n, output_tokens: n, cache_read_tokens: 0, cache_write_tokens: 0, token_semantics: 'inclusive' });
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ehgi-native-outbox-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { statePath: join(dir, 'usage.json'), client: 'codex', sessionId: '01a07a24-a447-75b3-890e-ceb683c31bfe', connectionScope: 'a'.repeat(64) };
}

test('persists baseline and pending usage together and replays lost acknowledgements after restart', async t => {
  const options = setup(t), outbox = create(options);
  outbox.record([row(100)]); outbox.record([row(120)]);
  let sent;
  await assert.rejects(outbox.flush(async report => { sent = report; throw new Error('offline'); }), /offline/);
  const restarted = create(options);
  assert.equal(restarted.pendingCount(), 1);
  await restarted.flush(async report => { assert.deepEqual(report, sent); assert.equal(report.input_tokens, 20); return { ok: true }; });
  assert.equal(restarted.pendingCount(), 0);
  const again = create(options); again.record([row(125)]);
  await again.flush(async report => { assert.equal(report.input_tokens, 25); assert.equal(report.session_id, sent.session_id); return { ok: true }; });
});

test('coalesces offline snapshots and retains a newer sample when an older delivery completes', async t => {
  const outbox = create(setup(t));
  outbox.record([row(100)]); outbox.record([row(110)]); outbox.record([row(120)]);
  assert.equal(outbox.pendingCount(), 1);
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const first = outbox.flush(async report => { assert.equal(report.input_tokens, 20); await wait; return { ok: true }; });
  assert.equal(outbox.flush(async () => { throw new Error('must be serialized'); }), first);
  outbox.record([row(130)]); release(); await first;
  assert.equal(outbox.pendingCount(), 1);
  await outbox.flush(async report => { assert.equal(report.input_tokens, 30); return { ok: true }; });
  assert.equal(outbox.pendingCount(), 0);
});

test('rejects invalid acknowledgements and connection changes without discarding reports', async t => {
  const options = setup(t), outbox = create(options);
  outbox.record([row(100)]); outbox.record([row(110)]);
  await assert.rejects(outbox.flush(async () => ({ ok: false })), /retained/);
  assert.equal(outbox.pendingCount(), 1);
  assert.throws(() => create({ ...options, connectionScope: 'b'.repeat(64) }));
  assert.equal(create(options).pendingCount(), 1);
});

test('revalidates disk totals and strips content fields before any delivery', async t => {
  const options = setup(t), outbox = create(options);
  outbox.record([row(100)]); outbox.record([row(110)]);
  const state = JSON.parse(readFileSync(options.statePath, 'utf8'));
  state.pending[0].prompt = 'PRIVATE'; state.window.latest[0].code = 'PRIVATE';
  writeFileSync(options.statePath, JSON.stringify(state));
  await create(options).flush(async report => { assert(!JSON.stringify(report).includes('PRIVATE')); return { ok: true }; });
  state.pending[0].input_tokens = 999;
  writeFileSync(options.statePath, JSON.stringify(state));
  assert.throws(() => create(options));
});

test('failed persistence latches failure and never delivers an unpersisted observation', async t => {
  const options = setup(t), outbox = create(options);
  outbox.record([row(100)]);
  // A directory in place of the state file must never be overwritten or ignored.
  rmSync(options.statePath);
  const { mkdirSync } = await import('node:fs'); mkdirSync(options.statePath);
  assert.throws(() => outbox.record([row(110)]));
  await assert.rejects(outbox.flush(async () => { assert.fail('must not deliver'); }));
});
