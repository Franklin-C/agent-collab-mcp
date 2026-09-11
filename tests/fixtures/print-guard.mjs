import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';

const home = resolve(process.env.FIXTURE_HOME), source = resolve(process.env.FIXTURE_SOURCE);
// Windows may inject OS home metadata even when spawn receives an explicit env.
// Remove every unrequested key before the CLI imports; retain only the synthetic
// home, frozen source, fallback token, and Windows module-loading essentials.
const allowed = new Set(['SYSTEMROOT','WINDIR','HOME','USERPROFILE','CODEX_HOME','TEMP','TMP','AGENT_COLLAB_TOKEN','FIXTURE_HOME','FIXTURE_SOURCE']);
let removedEnvironmentKeys = 0;
for (const name of Object.keys(process.env)) if (!allowed.has(name.toUpperCase())) { delete process.env[name]; removedEnvironmentKeys += 1; }
assert.equal(resolve(homedir()), home); assert.equal(resolve(process.cwd()), home);
assert.equal(resolve(process.env.CODEX_HOME), resolve(home, '.codex'));
assert.equal(resolve(process.env.HOME), home); assert.equal(resolve(process.env.USERPROFILE), home);
assert.equal(resolve(process.env.TEMP), home); assert.equal(resolve(process.env.TMP), home);
for (const name of Object.keys(process.env)) assert.ok(allowed.has(name.toUpperCase()), `Unexpected inherited variable: ${name}`);
if (process.env.AGENT_COLLAB_TOKEN) assert.equal(process.env.AGENT_COLLAB_TOKEN, 'ac_fixture_environment');
const forbidden = [], accessed = [];
const deny = kind => { forbidden.push(kind); throw Error(`Forbidden fixture operation: ${kind}`); };
const block = name => () => deny(name);
for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) childProcess[name] = block(`child_process.${name}`);
for (const [name, module] of [['http',http],['https',https]]) for (const method of ['request','get']) module[method] = block(`${name}.${method}`);
net.connect = block('net.connect'); net.createConnection = block('net.createConnection');
net.Socket.prototype.connect = block('net.Socket.connect'); tls.connect = block('tls.connect');
globalThis.fetch = block('fetch');
function within(parent, path) { const value = relative(parent, path); return !value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value); }
function inspect(value, write) {
  if (typeof value === 'number') return;
  const path = resolve(value instanceof URL ? fileURLToPath(value) : String(value));
  if (!(within(home, path) || !write && within(source, path))) deny(write ? 'write_outside_fixture' : 'read_outside_fixture');
  if (/(^|[\\/])(auth|credentials)\.json$/i.test(path)) deny('auth_file_access');
  accessed.push({ kind: write ? 'write' : 'read', scope: within(home, path) ? 'temporary_home' : 'frozen_source' });
}
for (const name of ['readFileSync','existsSync','lstatSync','statSync','readdirSync']) {
  const original = fs[name]; fs[name] = (path, ...args) => { inspect(path, false); return original(path, ...args); };
}
for (const name of ['writeFileSync','mkdirSync','unlinkSync','rmSync']) {
  const original = fs[name]; fs[name] = (path, ...args) => { inspect(path, true); return original(path, ...args); };
}
for (const name of ['renameSync','copyFileSync']) {
  const original = fs[name]; fs[name] = (from, to, ...args) => { inspect(from, true); inspect(to, true); return original(from, to, ...args); };
}
syncBuiltinESMExports();
process.once('exit', () => fs.writeFileSync(resolve(home, 'guard-observation.json'), JSON.stringify({ forbidden, accessed, removedEnvironmentKeys, environmentKeys: Object.keys(process.env).sort(), childClientLaunches: 0, actualNetworkCalls: 0 }), { flag: 'wx' }));
