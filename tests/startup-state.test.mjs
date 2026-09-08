import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginStartupAttempt, resetStartupRecovery } from '../bin/startup-state.mjs';
import { startupLauncher } from '../bin/service.mjs';

const absent = () => { throw Object.assign(Error('absent'), { code: 'ESRCH' }); };
function fixture(t) { const state = mkdtempSync(join(tmpdir(), 'ehgi-startup-')); t.after(() => rmSync(state, { recursive: true, force: true })); return state; }
const moduleUrl = new URL('../bin/startup-state.mjs', import.meta.url).href;
function childAttempt(state, finish) {
  const script = `import {beginStartupAttempt} from ${JSON.stringify(moduleUrl)}; const attempt=beginStartupAttempt(${JSON.stringify(state)}); console.log(JSON.stringify({allowed:attempt.allowed,crashes:attempt.crashes})); if(attempt.allowed) { ${finish ? `attempt.finish(${JSON.stringify(finish)});` : 'process.exit(70);'} }`;
  try { return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true })); }
  catch (error) { assert.equal(error.status, 70); return JSON.parse(error.stdout); }
}

test('real failed Node processes receive only three durable crash recoveries', t => {
  const state = fixture(t);
  for (let crashes = 0; crashes <= 3; crashes++) assert.deepEqual(childAttempt(state), { allowed: true, crashes });
  assert.deepEqual(childAttempt(state), { allowed: false });
  assert.equal(JSON.parse(readFileSync(join(state, 'startup-recovery.json'), 'utf8')).phase, 'needs_attention');
  assert.deepEqual(childAttempt(state), { allowed: false });
  resetStartupRecovery(state); assert.deepEqual(childAttempt(state, 'stopped'), { allowed: true, crashes: 0 });
});

for (const phase of ['stopped', 'needs_attention']) test(`${phase} is terminal across process replacements until explicit reset`, t => {
  const state = fixture(t); childAttempt(state, phase);
  assert.deepEqual(childAttempt(state), { allowed: false });
  resetStartupRecovery(state); assert.deepEqual(childAttempt(state, phase), { allowed: true, crashes: 0 });
});

test('a live/reused startup PID, active client or corrupt ledger cannot be reset or duplicated', t => {
  const state = fixture(t), attempt = beginStartupAttempt(state);
  assert.throws(() => beginStartupAttempt(state), /live or unverifiable/);
  assert.throws(() => resetStartupRecovery(state), /Stop the existing/);
  attempt.finish('stopped');
  writeFileSync(join(state, 'worker.lock'), JSON.stringify({ version: 1, pid: 99999, phase: 'client_active' }));
  assert.throws(() => resetStartupRecovery(state, { probe: absent }), /client lock/);
  writeFileSync(join(state, 'startup-recovery.json'), '{}');
  assert.throws(() => beginStartupAttempt(state), /Invalid startup/);
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
