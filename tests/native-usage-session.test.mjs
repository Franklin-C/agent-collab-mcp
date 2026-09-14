import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeUsageSession } from '../bin/native-usage-session.mjs';
const id = '01900000-0000-7000-8000-0000000000AB';

test('usage correlation comes from an explicit provider event or observed session callback', () => {
  assert.deepEqual(nativeUsageSession('claude-code', { session_id: id, prompt: 'PRIVATE' }), { client: 'claude-code', id: id.toLowerCase() });
  assert.deepEqual(nativeUsageSession('codex', {}, id), { client: 'codex', id: id.toLowerCase() });
  assert.equal(nativeUsageSession('codex', { text: id }), null);
  assert.equal(nativeUsageSession('gemini-cli', { session_id: id }), null);
  assert.equal(nativeUsageSession('codex', { session_id: 'invalid' }, id), null);
  assert.equal(nativeUsageSession('codex', {}, 'worker-generated-id'), null);
});
