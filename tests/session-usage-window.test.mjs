import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceSessionUsageWindow as advance } from '../bin/session-usage-window.mjs';

const options = { client: 'codex', sessionId: '01a07a24-a447-75b3-890e-ceb683c31bfe', connectionScope: 'a'.repeat(64) };
const row = (input, output = 2, cache = 0, extra = {}) => ({ model: 'gpt-6-astra', input_tokens: input, output_tokens: output, cache_read_tokens: cache, cache_write_tokens: 0, token_semantics: 'inclusive', ...extra });
const initial = () => advance(null, [row(100, 10, 30)], options).state;

test('existing history establishes a baseline and only subsequent usage is reported', () => {
  assert.deepEqual(advance(null, null, options), { state: null, reports: [] });
  const first = advance(null, [row(100, 10, 30)], options);
  assert.deepEqual(first.reports, []);
  const next = advance(first.state, [row(150, 20, 40)], options);
  assert.equal(next.reports.length, 1);
  assert.deepEqual(Object.fromEntries(['input_tokens', 'output_tokens', 'cache_read_tokens'].map(key => [key, next.reports[0][key]])), { input_tokens: 50, output_tokens: 10, cache_read_tokens: 10 });
  assert.equal(next.reports[0].cumulative, true);
  assert.deepEqual(advance(next.state, [row(150, 20, 40)], options).reports, []);
});

test('serialized restart and lost acknowledgement reproduce the same cumulative report', () => {
  const baseline = initial();
  const first = advance(baseline, [row(180, 30, 60)], options);
  const replay = advance(JSON.parse(JSON.stringify(baseline)), [row(180, 30, 60)], options);
  assert.deepEqual(replay, first);
  const later = advance(JSON.parse(JSON.stringify(first.state)), [row(200, 40, 70)], options);
  assert.equal(later.reports[0].input_tokens, 100);
  assert.equal(later.reports[0].session_id, first.reports[0].session_id);
  assert.notEqual(later.reports[0].event_id, first.reports[0].event_id);
});

test('models first observed after the baseline start at zero and retain separate totals', () => {
  const result = advance(initial(), [row(100, 10, 30), row(20, 4, 5, { model: 'gpt-5.6-sol' })], options);
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].model, 'gpt-5.6-sol');
  assert.equal(result.reports[0].input_tokens, 20);
});

test('rejects connection changes, regression, disappearing models and malformed persisted state', () => {
  const baseline = initial();
  for (const changed of [{ ...options, connectionScope: 'b'.repeat(64) }, { ...options, sessionId: '01a07a24-a447-75b3-890e-ceb683c31bff' }]) assert.throws(() => advance(baseline, null, changed));
  for (const snapshot of [[row(99, 10, 30)], [], [row(110, 20, 50)], [row(120, 20, 30), row(120, 20, 30)]]) assert.throws(() => advance(baseline, snapshot, options));
  assert.throws(() => advance({ ...baseline, window: 'forged' }, null, options));
  assert.throws(() => advance({ ...baseline, latest: [] }, null, options));
  assert.throws(() => advance({ ...baseline, latest: [row(99, 10, 30)] }, null, options));
});

test('only allowlisted counters leave the transition, including after disk round trips', () => {
  const baseline = initial();
  baseline.secret = 'PRIVATE'; baseline.baseline[0].prompt = 'PRIVATE';
  const snapshot = [row(150, 20, 40, { code: 'PRIVATE', token: 'PRIVATE', cost_usd: 999 })];
  const result = advance(baseline, snapshot, options);
  assert(!JSON.stringify(result).includes('PRIVATE'));
  assert(!JSON.stringify(result).includes('cost_usd'));
  assert(!JSON.stringify(result).includes(options.sessionId));
  assert(!JSON.stringify(result).includes(options.connectionScope));
});

test('Claude input and cache counters remain separate and validation never mutates a saved baseline', () => {
  const claude = { ...options, client: 'claude-code' };
  const first = advance(null, [row(10, 2, 100, { token_semantics: 'anthropic', cache_write_tokens: 50 })], claude);
  const saved = JSON.stringify(first.state);
  const next = advance(first.state, [row(12, 3, 200, { token_semantics: 'anthropic', cache_write_tokens: 60 })], claude);
  assert.equal(next.reports[0].input_tokens, 2);
  assert.equal(next.reports[0].cache_read_tokens, 100);
  assert.equal(next.reports[0].cache_write_tokens, 10);
  assert.equal(JSON.stringify(first.state), saved);
});
