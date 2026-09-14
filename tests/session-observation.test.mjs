import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSessionObservation } from '../bin/session-observation.mjs';

const sessionId = '01900000-0000-7000-8000-000000000001';
const usage = (input, output, cache = 0) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: cache });
const context = (cwd, model = 'gpt-5') => ({ type: 'turn_context', payload: { cwd, model } });
const meta = cwd => ({ type: 'session_meta', payload: { id: sessionId, cwd } });
const tokens = values => ({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: values } } });
const claude = (cwd, id = 'message_1', output = 5) => ({ type: 'assistant', sessionId, cwd, message: {
  id, model: 'claude-opus-5', usage: { input_tokens: 20, output_tokens: output, cache_read_input_tokens: 10, cache_creation_input_tokens: 2 },
  content: [{ type: 'text', text: 'PRIVATE PROMPT AND CODE' }],
} });

for (const [platform, cwd] of [['linux', '/home/dev/repo'], ['darwin', '/Users/dev/repo'], ['win32', 'Z:\\Franklin\\Github\\ehgi']]) {
  test(`Codex counters and model changes on ${platform}`, () => {
    const result = parseSessionObservation('codex', [meta(cwd), context(cwd), tokens(usage(100, 10, 20)), tokens(usage(100, 10, 20)), context(cwd, 'gpt-6'), tokens(usage(150, 20, 30))], { sessionId, cwd, platform });
    assert.deepEqual(result.map(({ model, input_tokens, output_tokens }) => ({ model, input_tokens, output_tokens })), [
      { model: 'gpt-5', input_tokens: 100, output_tokens: 10 }, { model: 'gpt-6', input_tokens: 50, output_tokens: 10 },
    ]);
  });
  test(`Claude repeated message snapshots on ${platform}`, () => {
    const result = parseSessionObservation('claude-code', [claude(cwd), claude(cwd, 'message_1', 8), claude(cwd, 'message_2', 3)], { sessionId, cwd, platform });
    assert.equal(result[0].input_tokens, 40);
    assert.equal(result[0].output_tokens, 11);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    assert.equal(JSON.stringify(result).includes(cwd), false);
  });
}
test('rejects a different session or workspace without releasing usage', () => {
  assert.throws(() => parseSessionObservation('codex', [meta('/other')], { sessionId, cwd: '/repo' }));
  assert.throws(() => parseSessionObservation('claude-code', [{ ...claude('/repo'), sessionId: 'foreign' }], { sessionId, cwd: '/repo' }));
});
test('never guesses a model or accepts decreasing native counters', () => {
  assert.throws(() => parseSessionObservation('codex', [meta('/repo'), tokens(usage(1, 1))], { sessionId, cwd: '/repo', platform: 'linux' }));
  assert.throws(() => parseSessionObservation('codex', [meta('/repo'), context('/repo'), tokens(usage(10, 2)), tokens(usage(9, 2))], { sessionId, cwd: '/repo', platform: 'linux' }));
});
test('rejects malformed counters and sidechain attribution', () => {
  const malformed = claude('/repo'); malformed.message.usage.input_tokens = -1;
  assert.throws(() => parseSessionObservation('claude-code', [malformed], { sessionId, cwd: '/repo', platform: 'linux' }));
  assert.throws(() => parseSessionObservation('claude-code', [{ ...claude('/repo'), isSidechain: true }], { sessionId, cwd: '/repo', platform: 'linux' }));
});
test('uses current Codex per-response records once across resumed UI counter resets', () => {
  const turn = { ...context('/repo'), payload: { cwd: '/repo', model: 'gpt-6', turn_id: 'turn-one' } };
  const native = { type: 'token_usage_record', payload: { thread_id: sessionId, turn_id: 'turn-one', response_id: 'response-one', usage: usage(10, 2) } };
  const reports = parseSessionObservation('codex', [meta('/repo'), context('/repo'), tokens(usage(100, 10)), turn, native, native, tokens(usage(10, 2))], { sessionId, cwd: '/repo', platform: 'linux' });
  assert.equal(reports[0].input_tokens, 100);
  assert.equal(reports[1].input_tokens, 10);
});
test('rejects native records belonging to another thread', () => {
  assert.throws(() => parseSessionObservation('codex', [meta('/repo'), { type: 'token_usage_record', payload: { thread_id: 'foreign' } }], { sessionId, cwd: '/repo', platform: 'linux' }));
});
