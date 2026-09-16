import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionActivityRecorder as create } from '../bin/session-activity.mjs';
import { safeActivity } from '../bin/activity.mjs';

const identity = { client: 'codex', sessionId: '01a07a24-a447-75b3-890e-ceb683c31bfe', connectionScope: 'a'.repeat(64) };
const row = (n, model = 'gpt-6-astra') => ({ model, token_semantics: 'inclusive', input_tokens: n, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 0 });

test('reports changed native counters as session observations without billing or private content', () => {
  const events = [];
  const recorder = create({ ...identity, reporter: { record: (event, context) => { events.push({ event, context }); return true; } } });
  assert.equal(recorder.record(null), false);
  assert.equal(recorder.record([row(100)]), false);
  assert.equal(recorder.record([row(100)]), false);
  assert.equal(recorder.record([{ ...row(110), prompt: 'PRIVATE' }, row(10, 'other-model')]), true);
  assert.deepEqual(events, [{ event: { kind: 'usage_reported', usageScope: 'session', inputTokens: 120, outputTokens: 4, cachedInputTokens: 6 }, context: { runId: identity.sessionId } }]);
  assert.deepEqual(safeActivity(events[0].event), events[0].event);
  assert.equal(recorder.record([row(110), row(10, 'other-model')]), false);
  assert(!JSON.stringify(events).includes('PRIVATE'));
});

test('a full activity outbox does not consume an observation before durable acceptance', () => {
  let full = true, attempts = 0;
  const recorder = create({ ...identity, reporter: { record: () => { attempts++; return !full; } } });
  recorder.record([row(10)]);
  assert.equal(recorder.record([row(20)]), false);
  full = false;
  assert.equal(recorder.record([row(20)]), true);
  assert.equal(recorder.record([row(20)]), false);
  assert.equal(attempts, 2);
});

test('Claude cache counters are normalized and invalid or regressing observations are refused', () => {
  let event;
  const recorder = create({ ...identity, client: 'claude-code', reporter: { record: value => { event = value; return true; } } });
  const claude = n => ({ ...row(n, 'claude-sonnet'), token_semantics: 'anthropic', cache_write_tokens: 4 });
  recorder.record([claude(10)]); recorder.record([claude(20)]);
  assert.equal(event.inputTokens, 27); assert.equal(event.cachedInputTokens, 3);
  assert.throws(() => recorder.record([claude(19)]), /baseline/);
  assert.throws(() => create({ ...identity, sessionId: 'other-session', reporter: { record() {} } }), /baseline/);
});

test('a failed durable write can retry the same observation without dropping it', () => {
  let fail = true;
  const events = [];
  const recorder = create({ ...identity, reporter: { record(event) {
    if (fail) throw new Error('disk full');
    events.push(event);
    return true;
  } } });
  recorder.record([row(10)]);
  assert.throws(() => recorder.record([row(20)]), /disk full/);
  fail = false;
  assert.equal(recorder.record([row(20)]), true);
  assert.equal(recorder.record([row(20)]), false);
  assert.equal(events.length, 1);
});

test('unsafe combined model totals never reach the activity outbox', () => {
  let attempts = 0;
  const recorder = create({ ...identity, reporter: { record() { attempts++; return true; } } });
  recorder.record([row(10), row(10, 'other-model')]);
  const huge = Math.floor(Number.MAX_SAFE_INTEGER / 2);
  assert.throws(() => recorder.record([row(huge), row(huge, 'other-model')]), /safe integer/);
  assert.equal(attempts, 0);
  assert.equal(recorder.record([row(20), row(20, 'other-model')]), true);
});
