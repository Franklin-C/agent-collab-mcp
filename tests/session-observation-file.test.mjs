import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessionObservation, createSessionFileObserver } from '../bin/session-observation-file.mjs';

const sessionId = '01900000-0000-7000-8000-000000000001';
async function fixture(run) {
  const cwd = await mkdtemp(join(tmpdir(), 'ehgi-session-observation-'));
  try {
    const path = join(cwd, `${sessionId}.jsonl`), options = { client: 'codex', sessionId, cwd };
    const records = [
      { type: 'session_meta', payload: { id: sessionId, cwd } },
      { type: 'turn_context', payload: { model: 'gpt-5', cwd } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 50 } } } },
    ];
    const content = records.map(record => JSON.stringify(record)).join('\n') + '\n';
    await writeFile(path, content);
    await run({ cwd, path, options, content });
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
test('reads only verified totals and ignores an incomplete trailing append', () => fixture(async ({ path, options, content }) => {
  await writeFile(path, content + '{"type":"event_msg","PRIVATE":"unfinished');
  const reports = await readSessionObservation(path, options);
  assert.equal(reports[0].input_tokens, 100);
  assert.equal(JSON.stringify(reports).includes('PRIVATE'), false);
}));

test('native workspace metadata commits only complete validated scans and returns copies', () => fixture(async ({ path, options, cwd }) => {
  const record = { type: 'assistant', sessionId, cwd, gitBranch: 'feature/a', message: { id: 'message', model: 'claude-test', usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'tool_use', name: 'Edit', id: 'edit', input: { file_path: join(cwd, 'a.ts'), new_string: 'PRIVATE' } }] } };
  await writeFile(path, JSON.stringify(record) + '\n');
  const observe = createSessionFileObserver(path, { ...options, client: 'claude-code' });
  await observe();
  assert.deepEqual(observe.workspaceMetadata(), { branch: 'feature/a', files: [] });
  const result = { type: 'user', sessionId, cwd, gitBranch: 'feature/a', message: { content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'PRIVATE' }] } };
  await appendFile(path, JSON.stringify(result) + '\n');
  await observe();
  const snapshot = observe.workspaceMetadata();
  assert.deepEqual(snapshot, { branch: 'feature/a', files: ['a.ts'] });
  snapshot.files.push('foreign');
  assert.deepEqual(observe.workspaceMetadata().files, ['a.ts']);
  await appendFile(path, JSON.stringify({ ...result, gitBranch: 'feature/b' }) + '\ninvalid\n');
  await assert.rejects(observe());
  assert.deepEqual(observe.workspaceMetadata(), { branch: 'feature/a', files: ['a.ts'] });
}));
test('rejects oversized individual records with bounded memory', () => fixture(async ({ path, options }) => {
  await assert.rejects(readSessionObservation(path, { ...options, maxRecordBytes: 1 }));
}));
test('reads appended totals once and completes a partial record on the next observation', () => fixture(async ({ path, options }) => {
  const observe = createSessionFileObserver(path, options);
  assert.equal((await observe())[0].input_tokens, 100);
  const next = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 150, output_tokens: 30, cached_input_tokens: 70 } } } });
  await appendFile(path, next.slice(0, 20));
  assert.equal((await observe())[0].input_tokens, 100);
  await appendFile(path, next.slice(20) + '\n');
  assert.equal((await observe())[0].input_tokens, 150);
  assert.equal((await observe())[0].input_tokens, 150);
}));
test('latches a truncation failure instead of reusing partial parser state', () => fixture(async ({ path, options, content }) => {
  const observe = createSessionFileObserver(path, options);
  await observe();
  await writeFile(path, '');
  await assert.rejects(observe());
  await writeFile(path, content);
  await assert.rejects(observe());
}));
test('rejects malformed committed JSON and wrong native sessions', () => fixture(async ({ path, options, content }) => {
  await assert.rejects(readSessionObservation(path, { ...options, sessionId: '01900000-0000-7000-8000-000000000002' }));
  await writeFile(path, content + 'not-json\n');
  await assert.rejects(readSessionObservation(path, options));
}));
test('rejects aliases with multiple hard links', () => fixture(async ({ cwd, path, options }) => {
  const alias = join(cwd, 'alias.jsonl');
  await link(path, alias);
  await assert.rejects(readSessionObservation(alias, options));
}));
test('waits for a fresh Claude session first usage record without latching a false failure', () => fixture(async ({ cwd, path, options }) => {
  await writeFile(path, JSON.stringify({ type: 'user', sessionId, cwd }) + '\n');
  const observe = createSessionFileObserver(path, { ...options, client: 'claude-code' });
  assert.equal(await observe(), null);
  await appendFile(path, JSON.stringify({ type: 'assistant', sessionId, cwd, message: { id: 'first', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + '\n');
  assert.equal((await observe())[0].output_tokens, 2);
}));

test('an already stopped watcher refuses even the initial file lookup', () => fixture(async ({ path, options }) => {
  const reason = new Error('operator stopped');
  const signal = AbortSignal.abort(reason);
  await assert.rejects(readSessionObservation(`${path}.missing`, { ...options, signal }), error => error === reason);
}));

test('turn state is exposed only after a complete verified file observation', () => fixture(async ({ path, options }) => {
  const observe = createSessionFileObserver(path, options);
  await observe();
  assert.equal(observe.turnState(), null);
  const turnId = '01900000-0000-7000-8000-000000000009';
  await appendFile(path, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } }) + '\n');
  await observe();
  const started = observe.turnState();
  assert.equal(started.kind, 'run_started');
  await appendFile(path, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, last_agent_message: 'PRIVATE' } }) + '\ninvalid\n');
  await assert.rejects(observe());
  assert.deepEqual(observe.turnState(), started);
}));

test('turn-like records before native session verification cannot become activity', () => fixture(async ({ path, options }) => {
  await writeFile(path, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: '01900000-0000-7000-8000-000000000009' } }) + '\n');
  const observe = createSessionFileObserver(path, options);
  assert.equal(await observe(), null);
  assert.equal(observe.turnState(), null);
  await appendFile(path, JSON.stringify({ type: 'session_meta', payload: { id: options.sessionId, cwd: options.cwd } }) + '\n');
  await observe();
  assert.equal(observe.turnState(), null);
}));

test('stop during an asynchronous scan discards its result and keeps the abort reason', () => fixture(async ({ path, options, content }) => {
  await writeFile(path, content + `${JSON.stringify({ type: 'message', text: 'private'.repeat(10000) })}\n`.repeat(100));
  const controller = new AbortController();
  const observe = createSessionFileObserver(path, { ...options, signal: controller.signal });
  const pending = observe();
  const reason = new Error('watch stopped during scan');
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  await assert.rejects(observe(), error => error === reason);
}));
