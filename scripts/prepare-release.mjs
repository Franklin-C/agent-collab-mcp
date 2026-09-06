// Read-only identity verification followed by a public staging directory; never publishes.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const scope = process.argv[2];
if (!/^@[a-z0-9][a-z0-9-]*$/.test(scope ?? '')) throw new Error('Usage: node scripts/prepare-release.mjs @owned-scope');
const username = execFileSync('npm', ['whoami', '--registry=https://registry.npmjs.org'], { encoding:'utf8', stdio:['ignore','pipe','pipe'] }).trim();
if (scope !== `@${username}`) {
  const members = JSON.parse(execFileSync('npm', ['org','ls',scope.slice(1),'--json','--registry=https://registry.npmjs.org'], {encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  if (!['owner','admin','developer'].includes(members[username])) throw new Error('Authenticated identity has no verified publishing role in this scope.');
}
const source = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', source),'utf8'));
manifest.name = `${scope}/agent-collab-mcp`; manifest.private = false;
manifest.repository = {type:'git',url:'git+https://github.com/Franklin-C/agent-collab-mcp.git'};
manifest.publishConfig = {access:'public',registry:'https://registry.npmjs.org',provenance:true};
const destination = mkdtempSync(join(tmpdir(),'agent-collab-release-'));
cpSync(new URL('bin',source),join(destination,'bin'),{recursive:true});cpSync(new URL('README.md',source),join(destination,'README.md'));
writeFileSync(join(destination,'package.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({username,name:manifest.name,version:manifest.version,directory:destination,published:false}));
