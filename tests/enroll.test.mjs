import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { enroll } from '../bin/enroll.mjs';
import { git, readHandoff } from '../bin/worker.mjs';
import { configureCodex } from '../bin/codex-config.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ehgi-enrollment-')), repo = join(root, 'repo'), state = join(root, 'state'); mkdirSync(repo);
  git(repo, ['init', '-b', 'main']); git(repo, ['config', 'user.name', 'Test']); git(repo, ['config', 'user.email', 'test@example.test']);
  writeFileSync(join(repo, 'README.md'), 'fixture'); git(repo, ['add', '.']); git(repo, ['commit', '-m', 'base']); git(repo, ['remote', 'add', 'origin', 'https://github.com/fixture/repo.git']);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, repo, state, host: 'http://localhost', token: 'fixture', write: true, model: 'gpt-test', capability: { client: 'codex', compatible: true, version: 'fixture' }, fetch: async (_url, options) => {
    const packet = JSON.parse(options.body); return Response.json(packet.action === 'challenge' ? { challenge: randomUUID() } : { verified: true });
  } };
}
test('a successful HTTP probe cannot claim actual client readiness', async t => {
  const options = fixture(t);
  await assert.rejects(enroll({ ...options, runClient: async () => ({ completed: true }) }), /file-edit probe/);
  assert.equal(JSON.parse(readFileSync(join(options.state, 'state.json'))).enrollment, undefined);
});
test('client file proof and hub roundtrip both required before readiness is saved', async t => {
  const options = fixture(t); let turns = 0;
  const result = await enroll({ ...options, runClient: async (_client, prompt, run) => {
    assert.equal(run.env.AGENT_COLLAB_TOKEN, options.token);
    turns++; const proof = JSON.parse(prompt.match(/Write exactly ("[^"]+") into/)[1]);
    writeFileSync(join(run.cwd, prompt.match(/into (\.ehgi-enrollment-[a-f0-9-]+)/)[1]), proof);
    run.onUsage({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }); return { completed: true };
  } });
  assert.equal(turns, 1); assert.equal(result.verified, true);
  assert.equal(JSON.parse(readFileSync(join(options.state, 'state.json'))).enrollment.repository, 'fixture/repo');
});

test('enrollment rejects missing model attribution before HTTP or model execution', async t => {
  const options = fixture(t); let requests = 0, turns = 0;
  await assert.rejects(enroll({ ...options, model: undefined, fetch: async () => { requests++; return Response.json({}); }, runClient: async () => { turns++; } }), /Specify --model/);
  assert.equal(requests, 0); assert.equal(turns, 0);
});

test('client proof without measurable usage cannot mark a worker ready', async t => {
  const options = fixture(t); let verified = false;
  await assert.rejects(enroll({ ...options, fetch: async (url, request) => { if (JSON.parse(request.body).action === 'verify') verified = true; return options.fetch(url, request); }, runClient: async (_client, prompt, run) => {
    writeFileSync(join(run.cwd, prompt.match(/into (\.ehgi-enrollment-[a-f0-9-]+)/)[1]), JSON.parse(prompt.match(/Write exactly ("[^"]+") into/)[1])); return { completed: true };
  } }), /no measurable usage/);
  assert.equal(verified, false);
});
test('handoff validation rejects missing, fabricated shape and excessive evidence', t => {
  const f = fixture(t); assert.throws(() => readHandoff(f.repo), /no .ehgi-handoff/);
  writeFileSync(join(f.repo, '.ehgi-handoff.json'), JSON.stringify({ outcome: 'deployed', summary: 'done' })); assert.throws(() => readHandoff(f.repo), /Invalid/);
  writeFileSync(join(f.repo, '.ehgi-handoff.json'), JSON.stringify({ outcome: 'more_work', summary: 'Checks need fixing', evidence: ['test failed'], nextSteps: ['Fix failing test'] }));
  assert.equal(readHandoff(f.repo).outcome, 'more_work');
});
test('Codex reconnect preserves name and unrelated settings and never duplicates a server', () => {
  const before = 'model = "test"\n[mcp_servers.agent-collab]\nurl = "https://ehgi.ai/api/mcp"\nbearer_token_env_var = "AGENT_COLLAB_TOKEN"\n[mcp_servers.other]\nurl = "https://example.test"\n';
  const after = configureCodex(before, 'https://ehgi.ai/api/mcp');
  assert.match(after, /tool_timeout_sec = 120/); assert.match(after, /model = "test"/); assert.doesNotMatch(after, /mcp_servers.agent_collab/);
  assert.equal(configureCodex(after, 'https://ehgi.ai/api/mcp'), after);
  assert.throws(() => configureCodex(after, 'https://other.test/api/mcp'), /differs/);
  assert.throws(() => configureCodex(before + '[mcp_servers.agent_collab]\n', 'https://ehgi.ai/api/mcp'), /Multiple/);
});
