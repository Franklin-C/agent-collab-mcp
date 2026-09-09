import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageCollector } from '../bin/usage.mjs';

const codexTurn = extra => ({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3, cached_input_tokens: 4 }, ...extra });

test('Codex provider IDs deduplicate a replay without collapsing distinct equal-sized turns', () => {
  const collect = createUsageCollector('codex', 'gpt-test');
  assert.equal(collect(codexTurn({ event_id: 'first' })).length, 1);
  assert.deepEqual(collect(codexTurn({ event_id: 'first' })), []);
  assert.equal(collect(codexTurn({ event_id: 'second' })).length, 1);
  assert.equal(collect(codexTurn()).length, 1);
  assert.equal(collect(codexTurn()).length, 1);
  assert.equal(collect(codexTurn({ event_id: '' })).length, 1);
  assert.equal(collect(codexTurn({ event_id: '' })).length, 1);
});

test('a new invocation has its own provider replay scope', () => {
  const event = { msg: codexTurn({ uuid: 'provider-id' }) };
  const first = createUsageCollector('codex', 'gpt-test');
  const second = createUsageCollector('codex', 'gpt-test');
  assert.equal(first(event).length, 1); assert.deepEqual(first(event), []);
  assert.equal(second(event).length, 1);
});

test('Claude records one final per-invocation snapshot and preserves each model/cache field', () => {
  const collect = createUsageCollector('claude-code');
  assert.deepEqual(collect({ type: 'assistant', message: { usage: { input_tokens: 500, output_tokens: 50 } } }), []);
  const event = { type: 'result', modelUsage: { first: { inputTokens: 3, outputTokens: 2, cacheReadInputTokens: 8, cacheCreationInputTokens: 4, costUSD: 0.02 }, second: { inputTokens: 5, outputTokens: 1 } } };
  const reports = collect(event);
  assert.equal(reports.length, 2);
  assert.deepEqual(reports[0], { model: 'first', input_tokens: 3, output_tokens: 2, cache_read_tokens: 8, cache_write_tokens: 4, cost_usd: 0.02, token_semantics: 'anthropic' });
  assert.equal(reports.reduce((sum, report) => sum + report.input_tokens, 0), 8);
  assert.deepEqual(collect(event), []);
  assert.deepEqual(collect({ ...event, uuid: 'different-transport-id' }), []);
  assert.equal(createUsageCollector('claude-code')(event).length, 2);
});

test('Gemini ignores intermediate events and repeated final totals within the same invocation', () => {
  const collect = createUsageCollector('gemini-cli', 'gemini-test');
  assert.deepEqual(collect({ type: 'tool_result', stats: { input_tokens: 200, output_tokens: 20 } }), []);
  const final = { type: 'result', stats: { input_tokens: 30, output_tokens: 4, cached: 10 } };
  assert.deepEqual(collect(final), [{ model: 'gemini-test', input_tokens: 30, output_tokens: 4, cache_read_tokens: 10, token_semantics: 'inclusive' }]);
  assert.deepEqual(collect(final), []);
  assert.equal(createUsageCollector('gemini-cli', 'gemini-test')(final).length, 1);
});

test('unmeasurable or malformed events cannot consume the final-report slot', () => {
  const collect = createUsageCollector('gemini-cli', 'gemini-test');
  for (const event of [null, undefined, 'diagnostic', { type: 'result', stats: {} }, { type: 'result', stats: { input_tokens: -1, output_tokens: 3 } }]) assert.deepEqual(collect(event), []);
  assert.equal(collect({ type: 'result', stats: { input_tokens: 0, output_tokens: 0 } }).length, 1);
});
