import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exercise the checkout's CLI entry point rather than a copy of its parser.
const cli = fileURLToPath(new URL('../bin/agent-collab-mcp.mjs', import.meta.url));
const preload = new URL('./fixtures/doctor-fetch.mjs', import.meta.url).href;
const host = ['--host', 'https://fixture.invalid'];
const cases = [
  { name: 'omitted report flag', args: host, expected: 0 },
  { name: 'bare report flag', args: [...host, '--report'], expected: 1 },
  { name: 'explicit true', args: [...host, '--report', 'true'], expected: 1 },
  { name: 'explicit false', args: [...host, '--report', 'false'], expected: 0 },
  { name: 'false before host', args: ['--report', 'false', ...host], expected: 0 },
  { name: 'last repeated value is false', args: ['--report', 'true', ...host, '--report', 'false'], expected: 0 },
  { name: 'last repeated value is true', args: ['--report', 'false', ...host, '--report', 'true'], expected: 1 },
  // The parser does not support equals syntax. This is an unchanged negative
  // control, not a claim that --report=true is a supported opt-in.
  { name: 'unsupported equals-false remains non-reporting', args: [...host, '--report=false'], expected: 0 },
  { name: 'requested report rejection remains best-effort', args: [...host, '--report', 'true'], expected: 1, status: 503 },
];

for (const item of cases) test(`doctor: ${item.name}`, { timeout: 15000 }, t => {
  const home = mkdtempSync(join(tmpdir(), 'agent-collab-doctor-flags-'));
  t.after(() => {
    const target = resolve(home);
    assert.equal(dirname(target), resolve(tmpdir()), 'Cleanup must remain in the fixture temp parent.');
    assert(basename(target).startsWith('agent-collab-doctor-flags-'));
    rmSync(target, { recursive: true, force: true });
  });
  const observation = join(home, 'observation.json');
  const result = spawnSync(process.execPath, ['--import', preload, cli, 'doctor', ...item.args], {
    cwd: home,
    env: {
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
      HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), TEMP: home, TMP: home,
      AGENT_COLLAB_TOKEN: 'fixture-token',
      FIXTURE_OBSERVATION: observation,
      FIXTURE_READINESS_STATUS: String(item.status ?? 200),
    },
    encoding: 'utf8', timeout: 8000, maxBuffer: 32768,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert(existsSync(observation), 'The in-memory transport must record the actual CLI calls.');
  const observed = JSON.parse(readFileSync(observation, 'utf8'));
  assert.deepEqual(observed.forbidden, [], 'No native client or real network operation is permitted.');
  assert.deepEqual(observed.calls.slice(0, 4).map(call => [call.path, call.rpcMethod]), [
    ['/api/mcp/health', null], ['/api/mcp', 'initialize'], ['/api/mcp', 'notifications/initialized'], ['/api/mcp', 'tools/list'],
  ]);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ready, true);
  assert.equal(output.configuration, 'not_requested');
  assert.equal(output.executable, null);
  assert.deepEqual(readdirSync(home), ['observation.json'], 'Doctor must not create configuration, credential, state or backup files.');
  if (item.status === 503) assert.match(result.stderr, /Readiness report was not accepted/);
  else assert.equal(result.stderr, '');
  assert.equal(observed.calls.filter(call => call.path === '/api/agent/readiness').length, item.expected);
});
