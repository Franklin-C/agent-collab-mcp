import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeWorkspaceMetadata } from '../bin/native-workspace-metadata.mjs';

for (const [platform, cwd, file] of [['linux', '/repo', '/repo/src/a.ts'], ['darwin', '/Users/dev/repo', '/Users/dev/repo/src/a.ts'], ['win32', 'Z:\\Repo', 'z:\\repo\\src\\a.ts']]) {
  test(`${platform}: only completed native edits expose repository-relative paths`, () => {
    const state = createNativeWorkspaceMetadata('claude-code', { sessionId: 'session', cwd, platform });
    const record = (type, content, extra = {}) => ({ type, sessionId: 'session', cwd, gitBranch: 'feature/a', message: { content }, ...extra });
    const edit = { type: 'tool_use', name: 'Edit', id: 'edit', input: { file_path: file, old_string: 'PRIVATE', new_string: 'PRIVATE' } };
    state.observe(record('assistant', [edit]));
    assert.deepEqual(state.snapshot(), { branch: 'feature/a', files: [] });
    state.observe(record('user', [{ type: 'tool_result', tool_use_id: 'edit', content: 'PRIVATE' }]));
    assert.deepEqual(state.snapshot(), { branch: 'feature/a', files: ['src/a.ts'] });
    assert(!JSON.stringify(state.snapshot()).includes('PRIVATE'));
    state.observe(record('assistant', [edit], { gitBranch: 'feature/b' }));
    state.observe(record('user', [{ type: 'tool_result', tool_use_id: 'edit', is_error: true }], { gitBranch: 'feature/b' }));
    assert.deepEqual(state.snapshot(), { branch: 'feature/b', files: [] });
  });
}

test('foreign sessions, sidechains, unknown tools and escaping paths cannot report files', () => {
  const state = createNativeWorkspaceMetadata('claude-code', { sessionId: 'session', cwd: '/repo', platform: 'linux' });
  const base = { type: 'assistant', sessionId: 'session', cwd: '/repo' };
  for (const input of ['/other/private', '../outside', '/repo/a\nsecret']) {
    state.observe({ ...base, message: { content: [{ type: 'tool_use', name: 'Write', id: 'id', input: { file_path: input } }] } });
    state.observe({ ...base, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'id' }] } });
  }
  for (const extra of [{ sessionId: 'foreign' }, { cwd: '/other' }, { isSidechain: true }]) state.observe({ ...base, ...extra, gitBranch: 'bad' });
  assert.equal(state.snapshot(), null);
  const codex = createNativeWorkspaceMetadata('codex', { sessionId: 'session', cwd: '/repo' });
  codex.observe({ ...base, gitBranch: 'not-codex-metadata' });
  assert.equal(codex.snapshot(), null);
});

test('recent filenames stay within the shared UTF-8 storage budget', () => {
  const state = createNativeWorkspaceMetadata('claude-code', { sessionId: 'session', cwd: '/repo', platform: 'linux' });
  const base = { sessionId: 'session', cwd: '/repo', gitBranch: 'feature/a' };
  for (let index = 0; index < 30; index++) {
    state.observe({ ...base, type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', id: String(index), input: { file_path: `/repo/${'文'.repeat(100)}${index}.ts` } }] } });
    state.observe({ ...base, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: String(index) }] } });
  }
  const files = state.snapshot().files;
  assert(files.length < 30);
  assert(files.reduce((size, file) => size + Buffer.byteLength(file), 0) <= 4096);
  assert(files.at(-1).endsWith('29.ts'));
});
