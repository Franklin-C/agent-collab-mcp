import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeWorkspaceMetadata } from '../bin/native-workspace-metadata.mjs';

const codexFileChange = (changes, item = {}, event = {}) => ({ type: 'event_msg', payload: {
  type: 'item_completed', thread_id: 'session', turn_id: 'turn',
  item: { type: 'FileChange', id: 'edit', changes, status: 'completed', stdout: 'PRIVATE', stderr: 'PRIVATE', ...item }, ...event,
} });

for (const [platform, cwd, file] of [['linux', '/repo', '/repo/src/a.ts'], ['darwin', '/Users/dev/repo', '/Users/dev/repo/src/a.ts'], ['win32', 'Z:\\Repo', 'z:\\repo\\src\\a.ts']]) {
  test(`${platform}: completed Codex file items expose only confined filenames`, () => {
    const state = createNativeWorkspaceMetadata('codex', { sessionId: 'session', cwd, platform });
    for (const type of ['add', 'update', 'delete']) {
      state.observe(codexFileChange({ [file]: { type, unified_diff: 'PRIVATE', content: 'PRIVATE', move_path: null } }));
      assert.deepEqual(state.snapshot(), { branch: null, files: ['src/a.ts'] });
    }
    assert(!JSON.stringify(state.snapshot()).includes('PRIVATE'));
  });
}

test('Codex ignores foreign, unfinished, failed, unstructured and escaping file events', () => {
  const state = createNativeWorkspaceMetadata('codex', { sessionId: 'session', cwd: '/repo', platform: 'linux' });
  const changes = { '/repo/a.ts': { type: 'update' } };
  for (const status of ['inProgress', 'failed', 'declined', undefined]) state.observe(codexFileChange(changes, { status }));
  state.observe(codexFileChange(changes, {}, { thread_id: 'other' }));
  state.observe(codexFileChange(changes, {}, { type: 'item_started' }));
  state.observe(codexFileChange(changes, { type: 'CommandExecution' }));
  state.observe(codexFileChange(['/repo/a.ts']));
  for (const file of ['/other/private', '/repo/../outside', 'src/a.ts', '/repo/a\nsecret']) {
    state.observe(codexFileChange({ [file]: { type: 'add' } }));
  }
  state.observe(codexFileChange({ '/repo/a.ts': { type: 'unknown' } }));
  assert.equal(state.snapshot(), null);
});

test('Codex file history retains at most fifty recent unique paths', () => {
  const state = createNativeWorkspaceMetadata('codex', { sessionId: 'session', cwd: '/repo', platform: 'linux' });
  for (let i = 0; i < 60; i++) state.observe(codexFileChange({ [`/repo/${i}.ts`]: { type: 'add' } }));
  assert.equal(state.snapshot().files.length, 50);
  assert.equal(state.snapshot().files[0], '10.ts');
  state.observe(codexFileChange({ '/repo/10.ts': { type: 'update' } }));
  assert.equal(state.snapshot().files.at(-1), '10.ts');
  assert.equal(state.snapshot().files.length, 50);
});

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
