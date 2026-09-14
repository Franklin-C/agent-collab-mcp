import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activityConnectionScope, readConnectionIdentity } from '../bin/connection-identity.mjs';
import { createActivityReporter } from '../bin/activity.mjs';

const identity = { projectId: 'project-one', agentId: 'agent-one' };
test('identity is authenticated, sanitized and never follows a redirect', async () => {
  let options;
  const result = await readConnectionIdentity({ server: 'https://example.test', token: 'private-token', fetch: async (url, value) => {
    assert.equal(url, 'https://example.test/api/agent/identity'); options = value;
    return new Response(JSON.stringify({ project_id: identity.projectId, agent_id: identity.agentId, private: 'discard' }));
  } });
  assert.deepEqual(result, identity);
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.Authorization, 'Bearer private-token');
  assert(options.signal instanceof AbortSignal);
});
test('identity rejects unsafe destinations, malformed responses and revoked credentials', async () => {
  for (const server of ['http://example.test', 'https://name:secret@example.test', 'https://example.test/path', 'https://example.test?token=x']) {
    await assert.rejects(readConnectionIdentity({ server, token: 'x', fetch: () => { throw new Error('must not send'); } }), /safe server/);
  }
  for (const body of [{}, { project_id: 'other/project', agent_id: 'a' }, { project_id: 'p', agent_id: 42 }]) {
    await assert.rejects(readConnectionIdentity({ server: 'https://example.test', token: 'x', fetch: async () => new Response(JSON.stringify(body)) }), /verified project/);
  }
  await assert.rejects(readConnectionIdentity({ server: 'https://example.test', token: 'x', fetch: async () => new Response('PRIVATE', { status: 401 }) }), error => error.status === 401 && !error.message.includes('PRIVATE'));
  await assert.rejects(readConnectionIdentity({ server: 'https://example.test', token: 'x', fetch: async () => new Response('PRIVATE invalid JSON') }), error => /not valid JSON/.test(error.message) && !error.message.includes('PRIVATE'));
});

test('cancelled identity lookup never sends a credential', async () => {
  const controller = new AbortController();
  controller.abort();
  let requested = false;
  await assert.rejects(readConnectionIdentity({ server: 'https://example.test', token: 'x', signal: controller.signal, fetch: async () => { requested = true; } }), { name: 'AbortError' });
  assert.equal(requested, false);
});
test('authenticated scope survives rotation but separates servers, projects and agents', () => {
  const scope = activityConnectionScope('https://example.test', 'old', identity);
  assert.equal(scope, activityConnectionScope('https://example.test', 'new', identity));
  for (const [server, owner] of [['https://other.test', identity], ['https://example.test', { ...identity, projectId: 'p2' }], ['https://example.test', { ...identity, agentId: 'a2' }]]) {
    assert.notEqual(scope, activityConnectionScope(server, 'new', owner));
  }
  assert.notEqual(activityConnectionScope('https://example.test', 'old'), activityConnectionScope('https://example.test', 'new'));
});
test('rotated credentials replay the exact queue and another agent cannot take it', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ehgi-identity-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'activity.json');
  const common = { server: 'https://example.test', statePath, connectionIdentity: identity };
  const before = createActivityReporter({ ...common, token: 'old' });
  before.record({ kind: 'usage_reported', usageScope: 'session', inputTokens: 100, outputTokens: 10 }, { runId: 'run' });
  before.stop();
  const saved = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.throws(() => createActivityReporter({ ...common, token: 'new', connectionIdentity: { ...identity, agentId: 'different' } }), /another connection/);
  let delivered;
  const after = createActivityReporter({ ...common, token: 'new', fetch: async (_url, request) => {
    assert.equal(request.headers.Authorization, 'Bearer new');
    delivered = JSON.parse(request.body);
    return new Response(JSON.stringify({ acceptedThrough: delivered.events.at(-1).sequence }));
  } });
  try {
    await after.flush();
    assert.deepEqual(delivered, { runtimeId: saved.runtimeId, events: saved.pending });
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).nextSequence, saved.nextSequence);
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).pending.length, 0);
  } finally { await after.close(); }
});
