import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertEnrollmentBinding, executionBinding, invocation } from '../bin/client-adapters.mjs';
import { codexConfigPath, codexProfileName, configureCodex } from '../bin/codex-config.mjs';

const capability = { client: 'codex', version: 'codex-cli 0.153.4', executable: 'codex', profiles: true, resume: true };
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'ehgi-profile-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'config.toml'), 'model = "base-model"\n');
  writeFileSync(join(home, 'ehgi.config.toml'), 'approval_policy = "on-request"\napprovals_reviewer = "auto_review"\n');
  return { profile: 'ehgi', write: true, model: 'gpt-test', env: { CODEX_HOME: home } };
}
test('selected Codex profiles reach fresh and resumed exec without overriding their permissions', () => {
  for (const session of [null, 'session-1']) {
    const call = invocation(capability, session, { profile: 'ehgi', write: true, model: 'gpt-test' });
    assert.deepEqual(call.args.slice(0, 3), ['--profile', 'ehgi', 'exec']);
    assert(!call.args.includes('--sandbox')); assert(!call.args.includes('--ask-for-approval'));
    assert(!call.args.includes('--approve-for-me')); assert(!call.args.includes('--ignore-user-config'));
    assert.equal(call.args.at(-1), '-');
    if (session) assert(call.args.includes(session));
  }
  assert(invocation(capability, null, { write: true }).args.includes('workspace-write'));
  assert(invocation(capability, null, {}).args.includes('read-only'));
});
test('profile names cannot become paths or extra flags and unsupported adapters fail before execution', () => {
  for (const profile of ['../other', '/absolute', 'bad name', 'bad\nname', '']) assert.throws(() => codexProfileName(profile), /only letters/);
  assert.equal(codexProfileName('room_01-test'), 'room_01-test');
  assert.throws(() => invocation({ ...capability, profiles: false }, null, { profile: 'ehgi', write: true }), /0.134.0/);
  assert.throws(() => invocation({ ...capability, client: 'claude-code' }, null, { profile: 'ehgi', write: true }), /0.134.0/);
  assert.throws(() => invocation(capability, null, { profile: 'ehgi' }), /explicit --write/);
});
test('local enrollment binding rejects changed model, client, config, profile and Codex home', t => {
  const options = fixture(t), execution = executionBinding(capability, options);
  const enrolled = { verifiedAt: new Date().toISOString(), execution };
  assert.deepEqual(assertEnrollmentBinding(enrolled, capability, options), execution);
  const rejected = action => assert.throws(action, error => error.code === 'ENROLLMENT_CHANGED' && error.retryable === false);
  rejected(() => assertEnrollmentBinding(enrolled, capability, { ...options, model: 'other-model' }));
  rejected(() => assertEnrollmentBinding(enrolled, { ...capability, version: '0.154.0' }, options));
  rejected(() => assertEnrollmentBinding(enrolled, { ...capability, executable: 'other-codex' }, options));
  rejected(() => assertEnrollmentBinding(enrolled, capability, { ...options, profile: undefined }));
  rejected(() => assertEnrollmentBinding({}, capability, options));
  const other = join(options.env.CODEX_HOME, 'other'); mkdirSync(other);
  writeFileSync(join(other, 'ehgi.config.toml'), 'approval_policy = "on-request"\n');
  rejected(() => assertEnrollmentBinding(enrolled, capability, { ...options, env: { CODEX_HOME: other } }));
  writeFileSync(join(options.env.CODEX_HOME, 'config.toml'), 'model = "changed"\n');
  rejected(() => assertEnrollmentBinding(enrolled, capability, options));
  writeFileSync(join(options.env.CODEX_HOME, 'config.toml'), 'model = "base-model"\n');
  writeFileSync(join(options.env.CODEX_HOME, 'ehgi.config.toml'), 'approval_policy = "never"\n');
  rejected(() => assertEnrollmentBinding(enrolled, capability, options));
});
test('missing and linked profile files cannot stand in for a verified regular file', t => {
  const options = fixture(t);
  assert.throws(() => executionBinding(capability, { ...options, profile: 'missing' }), /profile file is missing/);
  const path = codexConfigPath({ ...options, profile: 'linked' });
  try { symlinkSync(join(options.env.CODEX_HOME, 'ehgi.config.toml'), path, 'file'); }
  catch (error) { if (error.code !== 'EPERM') throw error; symlinkSync(options.env.CODEX_HOME, path, 'junction'); }
  assert.throws(() => executionBinding(capability, { ...options, profile: 'linked' }), /regular file/);
});
test('profile MCP configuration retains the inherited server name and only adds connection fields', () => {
  const profile = 'approval_policy = "on-request"\n';
  const result = configureCodex(profile, 'https://ehgi.ai/api/mcp', { inherited: '[mcp_servers.agent-collab]\nurl = "https://ehgi.ai/api/mcp"\n' });
  assert(result.startsWith(profile)); assert.match(result, /\[mcp_servers.agent-collab\]/);
  assert.doesNotMatch(result, /mcp_servers.agent_collab|approvals_reviewer|default_tools_approval_mode/);
});
