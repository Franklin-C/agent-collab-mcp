import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRelease } from '../scripts/prepare-release.mjs';
const repository = 'Franklin-C/agent-collab-mcp';
const source = { repository, version: '0.3.2', head: 'a'.repeat(40), tagCommit: 'a'.repeat(40),
  manifest: { name: '@franklineh/agent-collab-mcp', version: '0.3.2', repository: { url: `git+https://github.com/${repository}.git` } } };
test('a matching reviewed tag is verified without claiming publication', () => {
  assert.deepEqual(verifyRelease(source), { repository, version: '0.3.2', tag: 'v0.3.2', commit: source.head, published: false });
});
for (const patch of [{ repository: 'Franklin-C/agent-collab' }, { version: '0.3.3' }, { version: '0.3.2;echo bad' },
  { version: '00.3.2' }, { tagCommit: 'b'.repeat(40) }, { head: 'bad' }, { expectedHead: 'b'.repeat(40) }, { dirty: true },
  { manifest: { ...source.manifest, repository: { url: 'https://example.test' } } }]) {
  test(`rejects mismatched release evidence ${JSON.stringify(patch)}`, () => assert.throws(() => verifyRelease({ ...source, ...patch })));
}
