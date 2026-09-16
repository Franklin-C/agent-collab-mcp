import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeAllowance, safeAllowance } from '../bin/subscription-allowance.mjs';
import { safeActivity } from '../bin/activity.mjs';
const timestamp = '2026-09-16T14:00:00.000Z';
test('Codex reads explicit subscription windows without leaking extra provider fields', () => {
  const parser = createNativeAllowance('codex');
  parser.observe({ type: 'event_msg', timestamp, payload: { type: 'token_count', rate_limits: { primary: { used_percent: 25, resets_at: Date.parse(timestamp) / 1000 + 3600 }, account: 'PRIVATE' }, context_window: 100, prompt: 'PRIVATE' } });
  assert.equal(parser.snapshot().windows[0].remainingPercent, 75);
  const event = safeActivity({ kind: 'allowance_reported', allowance: { ...parser.snapshot(), email: 'PRIVATE' } });
  assert(!JSON.stringify(event).includes('PRIVATE'));
  assert.equal(event.allowance.observedAt, timestamp);
});
test('missing provider limits stay unknown and malformed percentages are not inferred', () => {
  const parser = createNativeAllowance('codex');
  parser.observe({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100000 } } } });
  assert.equal(parser.snapshot(), null);
  assert.equal(createNativeAllowance('gemini-cli').snapshot(), null);
  assert.equal(safeAllowance({ provider: 'codex', observedAt: timestamp, windows: [{ name: 'primary', remainingPercent: 101, limited: false, resetsAt: null }] }), null);
});
