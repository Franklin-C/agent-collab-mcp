import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginStartupAttempt, resetStartupRecovery } from '../bin/startup-state.mjs';
import { startupLauncher } from '../bin/service.mjs';

const absent = () => { throw Object.assign(Error('absent'), { code: 'ESRCH' }); };
function fixture(t) { const state = mkdtempSync(join(tmpdir(), 'ehgi-startup-')); t.after(() => rmSync(state, { recursive: true, force: true })); return state; }
const moduleUrl = new URL('../bin/startup-state.mjs', import.meta.url).href;
function childAttempts(state) {
  const exitedPids = new Set();
  // spawnSync confirms each exact child has exited, but its numeric PID can
  // already belong to another process by the next spawn. Model absence only
  // for those reaped children here; test production liveness separately below.
  return {
    attempt(finish) {
      const script = `import {beginStartupAttempt} from ${JSON.stringify(moduleUrl)};
        const exitedPids=${JSON.stringify([...exitedPids])};
        const attempt=beginStartupAttempt(${JSON.stringify(state)}, {probe(pid,signal) {
          if(signal!==0 || !exitedPids.includes(pid)) throw Error('Unexpected process probe');
          throw Object.assign(Error('The fixture reaped this child'), {code:'ESRCH'});
        }});
        console.log(JSON.stringify({pid:process.pid,result:{allowed:attempt.allowed,crashes:attempt.crashes}}));
        if(attempt.allowed) { ${finish ? `attempt.finish(${JSON.stringify(finish)});` : 'process.exit(70);'} }`;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
      assert.ifError(child.error);
      assert.equal(child.signal, null, child.stderr);
      assert.ok(child.status === 0 || child.status === 70, child.stderr);
      const { pid, result } = JSON.parse(child.stdout);
      assert.equal(pid, child.pid);
      assert.equal(child.status, result.allowed && !finish ? 70 : 0, child.stderr);
      exitedPids.add(child.pid);
      return result;
    },
    reset() {
      return resetStartupRecovery(state, { probe(pid, signal) {
        assert.equal(signal, 0);
        assert.ok(exitedPids.has(pid), 'only a synchronously reaped fixture PID may be treated as absent');
        absent();
      } });
    },
  };
}

test('real failed Node processes receive only three durable crash recoveries', t => {
  const state = fixture(t), children = childAttempts(state);
  for (let crashes = 0; crashes <= 3; crashes++) assert.deepEqual(children.attempt(), { allowed: true, crashes });
  assert.deepEqual(children.attempt(), { allowed: false });
  assert.equal(JSON.parse(readFileSync(join(state, 'startup-recovery.json'), 'utf8')).phase, 'needs_attention');
  assert.deepEqual(children.attempt(), { allowed: false });
  children.reset(); assert.deepEqual(children.attempt('stopped'), { allowed: true, crashes: 0 });
});

for (const phase of ['stopped', 'needs_attention']) test(`${phase} is terminal across process replacements until explicit reset`, t => {
  const state = fixture(t), children = childAttempts(state); children.attempt(phase);
  assert.deepEqual(children.attempt(), { allowed: false });
  children.reset(); assert.deepEqual(children.attempt(phase), { allowed: true, crashes: 0 });
});

test('a live startup PID, active client or corrupt ledger cannot be reset or duplicated', t => {
  const state = fixture(t), attempt = beginStartupAttempt(state);
  assert.throws(() => beginStartupAttempt(state), /live or unverifiable/);
  assert.throws(() => resetStartupRecovery(state), /Stop the existing/);
  attempt.finish('stopped');
  writeFileSync(join(state, 'worker.lock'), JSON.stringify({ version: 1, pid: 99999, phase: 'client_active' }));
  assert.throws(() => resetStartupRecovery(state, { probe: absent }), /client lock/);
  writeFileSync(join(state, 'startup-recovery.json'), '{}');
  assert.throws(() => beginStartupAttempt(state), /Invalid startup/);
});

test('a reaped startup PID reassigned to a live replacement is refused without changing the ledger', t => {
  const state = fixture(t), children = childAttempts(state);
  assert.deepEqual(children.attempt(), { allowed: true, crashes: 0 });
  // Deterministically model OS PID reuse: the old process really exited, then
  // its saved numeric PID refers to this live replacement. Use the real probe.
  const file = join(state, 'startup-recovery.json'), prior = JSON.parse(readFileSync(file, 'utf8'));
  assert.notEqual(prior.pid, process.pid);
  writeFileSync(file, JSON.stringify({ ...prior, pid: process.pid }));
  const before = readFileSync(file, 'utf8');
  assert.throws(() => beginStartupAttempt(state), /live or unverifiable/);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.throws(() => resetStartupRecovery(state), /Stop the existing/);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('an inaccessible startup PID is refused without changing the ledger', t => {
  const state = fixture(t), children = childAttempts(state);
  children.attempt();
  const file = join(state, 'startup-recovery.json'), before = readFileSync(file, 'utf8'), prior = JSON.parse(before);
  let probes = 0;
  const probe = (pid, signal) => {
    assert.equal(pid, prior.pid); assert.equal(signal, 0); probes++;
    throw Object.assign(Error('Permission denied'), { code: 'EPERM' });
  };
  assert.throws(() => beginStartupAttempt(state, { probe }), /live or unverifiable/);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.throws(() => resetStartupRecovery(state, { probe }), /Stop the existing/);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(probes, 2);
});

test('generated platform launchers are valid JavaScript and import failures exit successfully without a restart loop', t => {
  const state = fixture(t);
  for (const platform of ['win32', 'darwin', 'linux']) {
    const path = join(state, `${platform}.mjs`);
    writeFileSync(path, startupLauncher({ platform, label: 'ai.ehgi.worker.0123456789abcdef', state, worker: new URL('./missing/worker.mjs', import.meta.url).href, options: {}, codexHome: 'test codex home' }));
    execFileSync(process.execPath, ['--check', path], { windowsHide: true });
    execFileSync(process.execPath, [path], { windowsHide: true });
    assert.equal(JSON.parse(readFileSync(join(state, 'startup-status.json'), 'utf8')).state, 'needs_attention');
  }
});
