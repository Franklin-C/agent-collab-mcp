// Verify a reviewed GitHub source release. Never publishes or changes tags.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repository = 'Franklin-C/agent-collab-mcp';
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function verifyRelease({ manifest, version, head, tagCommit, repository: actualRepository, expectedHead = head, dirty = false }) {
  if (typeof version !== 'string' || !versionPattern.test(version) || !version.split('.').every(part => Number.isSafeInteger(Number(part)))) throw new Error('Use an exact stable version such as 0.3.2.');
  if (actualRepository !== repository || manifest?.repository?.url !== `git+https://github.com/${repository}.git`
    || manifest.name !== '@franklineh/agent-collab-mcp' || manifest.version !== version) throw new Error('The repository or committed connector version does not match this release.');
  if (!/^[a-f0-9]{40}$/.test(head ?? '') || tagCommit !== head || expectedHead !== head || dirty) throw new Error('Release only a clean checkout whose existing version tag and selected commit match HEAD.');
  return { repository, version, tag: `v${version}`, commit: head, published: false };
}
function main() {
  const [version, extra] = process.argv.slice(2);
  if (extra || !versionPattern.test(version ?? '')) throw new Error('Usage: node scripts/prepare-release.mjs VERSION');
  const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
  const origin = git(['config', '--get', 'remote.origin.url']);
  const origins = [`https://github.com/${repository}.git`, `https://github.com/${repository}`, `git@github.com:${repository}.git`];
  if (!origins.includes(origin)) throw new Error('Run this in the reviewed standalone connector checkout.');
  const head = git(['rev-parse', '--verify', 'HEAD']);
  const result = verifyRelease({ manifest: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')), version, head,
    tagCommit: git(['rev-parse', '--verify', `refs/tags/v${version}^{commit}`]), repository: process.env.GITHUB_REPOSITORY ?? repository,
    expectedHead: process.env.GITHUB_SHA ?? head, dirty: git(['status', '--porcelain', '--untracked-files=no']) !== '' });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
