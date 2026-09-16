import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWatchObservations } from '../bin/watch-observations.mjs';

test('Stop during identity resolution cannot start an observation loop or create its outbox', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ehgi-observation-stop-'));
  const sessionFile = join(directory, 'session.jsonl');
  const sessionId = '11111111-1111-4111-8111-111111111111';
  await writeFile(sessionFile, `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: directory } })}\n`);
  const controller = new AbortController();
  const reason = new Error('Operator stopped');
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    requests++;
    assert.equal(url, 'https://example.test/api/agent/identity');
    return { ok: true, async json() {
      // Cancel after the identity helper's final check, before its caller resumes.
      queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => controller.abort(reason))));
      return { project_id: 'project', agent_id: 'agent' };
    } };
  });
  let watcher;
  try {
    await assert.rejects(async () => {
      watcher = await startWatchObservations({ client: 'codex', sessionId, sessionFile, cwd: directory,
        server: 'https://example.test', token: 'fixture-token', directory, signal: controller.signal });
    }, error => error === reason);
    assert.equal(requests, 1);
    assert.deepEqual(await readdir(directory), ['session.jsonl']);
  } finally {
    await watcher?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
