import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

// The real checkout module uses an injected GitHub response. No network,
// authentication, native client, or supervisor is needed for cache behavior.
const forbidden = [], originals = [];
function block(target, name, label) {
  originals.push([target, name, target[name]]);
  target[name] = () => { forbidden.push(label); throw Error(`Forbidden fixture operation: ${label}`); };
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) block(childProcess, name, `child_process.${name}`);
for (const [label, module] of [['http', http], ['https', https]]) for (const name of ['request', 'get']) block(module, name, `${label}.${name}`);
block(net, 'connect', 'net.connect'); block(net, 'createConnection', 'net.createConnection');
block(net.Socket.prototype, 'connect', 'net.Socket.connect'); block(tls, 'connect', 'tls.connect');
block(globalThis, 'fetch', 'fetch'); syncBuiltinESMExports();
after(() => {
  for (const [target, name, original] of originals) target[name] = original;
  syncBuiltinESMExports();
  assert.deepEqual(forbidden, [], 'Cache tests must never attempt real network or process launches');
});
const { checkUpdate } = await import('../bin/update-check.mjs');
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(manifest.private, false);
const repository = 'https://github.com/Franklin-C/agent-collab-mcp';
const api = 'https://api.github.com/repos/Franklin-C/agent-collab-mcp/releases';
const release = (version = '9.9.9') => ({ id: 12, tag_name: `v${version}`, draft: false, prerelease: false,
  url: `${api}/12`, html_url: `${repository}/releases/tag/v${version}` });
const cached = at => ({ name: manifest.name, source: 'github-releases-v1', repository, at });

function fixture(t, body) {
  const parent = resolve(tmpdir()), home = mkdtempSync(join(parent, 'agent-collab-update-cache-'));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  // os.homedir uses USERPROFILE on Windows; HOME alone is not sufficient.
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    const target = resolve(home);
    assert.equal(dirname(target), parent, 'Cleanup must remain within the fixture temp parent');
    assert.ok(basename(target).startsWith('agent-collab-update-cache-'));
    rmSync(target, { recursive: true, force: true });
  });
  assert.equal(resolve(homedir()), resolve(home), 'Update checks must use the isolated home');
  const cache = join(home, '.agent-collab/update-check.json');
  mkdirSync(dirname(cache)); writeFileSync(cache, body);
  const calls = [], logs = [];
  const fetcher = async (url, options) => {
    assert.equal(url, `${api}/latest`);
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Accept, 'application/vnd.github+json');
    calls.push({ requestedOwnedPackage: true });
    return Response.json(release());
  };
  return { cache, calls, logs, fetcher, log: message => logs.push(message) };
}

for (const [name, getBody] of [
  ['truncated JSON', () => '{"name":"partial","at":'],
  ['corrupt JSON', () => 'not JSON'],
  ['null JSON', () => 'null'],
  ['future timestamp', () => JSON.stringify(cached(Date.now() + 14 * 86400000))],
  ['numeric-string timestamp', () => JSON.stringify(cached(String(Date.now())))],
  ['old npm cache', () => JSON.stringify({ name: manifest.name, at: Date.now() })],
]) test(`ordinary update checks repair ${name}, then reuse the repaired cache`, async t => {
  const f = fixture(t, getBody());
  const first = await checkUpdate({ fetcher: f.fetcher, log: f.log });
  const second = await checkUpdate({ fetcher: f.fetcher, log: f.log });
  assert.equal(f.calls.length, 1, 'Invalid/stale cache must not disable update lookup');
  assert.equal(first.status, 'update'); assert.equal(second.status, 'cached');
  const repaired = JSON.parse(readFileSync(f.cache, 'utf8'));
  assert.equal(repaired.name, manifest.name); assert.ok(Number.isFinite(repaired.at));
  assert.equal(repaired.source, 'github-releases-v1'); assert.equal(repaired.repository, repository);
  assert.equal(f.logs.length, 1);
  assert(f.logs[0].includes(`${repository}/releases/tag/v9.9.9`));
  assert(!f.logs[0].includes('npm install'));
});

test('a fresh owned-package cache suppresses a repeated update request', async t => {
  const body = JSON.stringify(cached(Date.now() - 1000));
  const f = fixture(t, body), result = await checkUpdate({ fetcher: f.fetcher, log: f.log });
  assert.equal(result.status, 'cached'); assert.equal(f.calls.length, 0);
  assert.equal(readFileSync(f.cache, 'utf8'), body);
});

test('an expired cache rechecks and stores a confirmed package', async t => {
  const f = fixture(t, JSON.stringify(cached(Date.now() - 2 * 86400000)));
  const result = await checkUpdate({ fetcher: f.fetcher, log: f.log });
  assert.equal(result.status, 'update'); assert.equal(f.calls.length, 1);
  assert.ok(JSON.parse(readFileSync(f.cache, 'utf8')).at > Date.now() - 10000);
});

test('explicit force still recovers a malformed cache', async t => {
  const f = fixture(t, 'not JSON'), result = await checkUpdate({ force: true, fetcher: f.fetcher, log: f.log });
  assert.equal(result.status, 'update'); assert.equal(f.calls.length, 1);
});

test('an unconfirmed release identity cannot overwrite the retained cache', async t => {
  const body = JSON.stringify({ name: manifest.name, at: 1 }), f = fixture(t, body);
  const result = await checkUpdate({ log: f.log, fetcher: async (...args) => {
    await f.fetcher(...args);
    return Response.json({ ...release(), html_url: 'https://fixture.invalid/wrong-repository' });
  } });
  assert.equal(result.status, 'unavailable'); assert.equal(f.calls.length, 1);
  assert.equal(readFileSync(f.cache, 'utf8'), body); assert.equal(f.logs.length, 0);
});

for (const patch of [{ draft: true }, { prerelease: true }, { draft: undefined }, { tag_name: 'v1.2.3;bad' },
  { tag_name: 'v01.2.3' }, { tag_name: 'v9007199254740992.0.0' }, { id: -1 }, { url: `${api}/99` }]) {
  test(`rejects invalid or unpublished release metadata ${JSON.stringify(patch)}`, async t => {
    const f = fixture(t, '{}');
    assert.equal((await checkUpdate({ fetcher: async () => Response.json({ ...release(), ...patch }), log: f.log })).status, 'unavailable');
    assert.equal(readFileSync(f.cache, 'utf8'), '{}'); assert.deepEqual(f.logs, []);
  });
}

test('no GitHub release is a supported source-only installation, not an npm error', async t => {
  const f = fixture(t, '{}');
  assert.deepEqual(await checkUpdate({ fetcher: async () => new Response('', { status: 404 }), log: f.log }), { status: 'unreleased', current: manifest.version });
  assert.deepEqual(f.logs, []);
});

for (const version of [manifest.version, '0.0.0']) test(`does not suggest a reinstall for ${version}`, async t => {
  const f = fixture(t, '{}');
  assert.equal((await checkUpdate({ fetcher: async () => Response.json(release(version)), log: f.log })).status, 'current');
  assert.deepEqual(f.logs, []);
});

test('failed update lookup retains the cache and a later call can recover', async t => {
  const body = JSON.stringify({ name: manifest.name, at: 1 }), f = fixture(t, body);
  const failed = await checkUpdate({ log: f.log, fetcher: async (...args) => { await f.fetcher(...args); return new Response('', { status: 503 }); } });
  const afterFailure = readFileSync(f.cache, 'utf8');
  const repaired = await checkUpdate({ fetcher: f.fetcher, log: f.log });
  assert.equal(failed.status, 'unavailable'); assert.equal(afterFailure, body);
  assert.equal(repaired.status, 'update'); assert.equal(f.calls.length, 2);
});
