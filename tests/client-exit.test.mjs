import { networkAttempts } from './fixtures/client-exit-network-guard.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { tmpdir } from 'node:os';

const root = dirname(fileURLToPath(import.meta.url));
const pause = ms => new Promise(done => setTimeout(done, ms));
function read(directory, name) {
  const path = join(directory, `${name}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}
function status(record) {
  if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 0) return 'unknown';
  try {
    process.kill(record.pid, 0);
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${record.pid}/stat`, 'utf8');
      const parts = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (record.birth && record.birth !== parts[19]) return 'reused';
      if (parts[0] === 'Z') return 'zombie';
    }
    return 'alive';
  } catch (error) { return ['ESRCH', 'ENOENT'].includes(error.code) ? 'absent' : 'unknown'; }
}
function terminate(record, nonce) {
  if (record?.nonce !== nonce || status(record) !== 'alive') return;
  try { process.kill(record.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
function exitOf(child, timeout) {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(Error(`Outer CLI did not close within ${timeout} ms`)), timeout);
    child.once('error', error => { clearTimeout(timer); fail(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); done({ code, signal, closedAt: Date.now() }); });
  });
}
async function exercise(t, mode) {
  const nonce = randomUUID();
  const parent = resolve(tmpdir());
  const directory = mkdtempSync(join(parent, 'agent-collab-client-exit-'));
  t.after(async () => {
    const target = resolve(directory);
    assert.equal(dirname(target), parent);
    assert.ok(basename(target).startsWith('agent-collab-client-exit-'));
    // Windows releases a killed process's cwd a few ms after kill(pid, 0) reports
    // it gone. Only the asynchronous rm retries EBUSY; the synchronous one throws it.
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const env = Object.fromEntries(Object.entries({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    TEMP: directory, TMP: directory, TMPDIR: directory, HOME: directory, USERPROFILE: directory, CODEX_HOME: join(directory, 'codex-home'),
  }).filter(([, value]) => value !== undefined));
  const evidence = { mode, nonce, platform: process.platform, node: process.version, startedAt: Date.now() };
  const outer = spawn(process.execPath, [join(root, 'fixtures/client-exit-outer.mjs'), mode, directory, nonce], { env, windowsHide: true, stdio: 'ignore' });
  const closed = exitOf(outer, mode === 'slow' ? 9000 : 6500);
  try {
    evidence.outer = await closed;
    evidence.result = read(directory, 'outer-result');
    evidence.nativeExit = read(directory, 'outer-exit');
    evidence.client = read(directory, 'client');
    evidence.clientExit = read(directory, 'client-exit');
    evidence.descendant = read(directory, 'descendant');
    assert.equal(evidence.outer.code, 0);
    assert.equal(evidence.nativeExit?.nonce, nonce);
    assert.equal(evidence.result?.nonce, nonce);
    assert.equal(evidence.clientExit?.code, 0, 'Synthetic direct client must have actually exited zero');
    assert.deepEqual(evidence.result.networkAttempts, []);
    const result = evidence.result;
    const terminal = result.activity.filter(event => ['run_finished', 'run_failed', 'run_stopped'].includes(event.kind));
    assert.equal(terminal.length, 1, 'Exit/close race must finalize and announce once');
    assert.equal(result.usageAttempts.length, 2, 'Exact final checkpoint must be observed once after lower stdout usage');
    assert.equal(new Set(result.usageAttempts.map(item => item.id)).size, 2);
    if (mode === 'failing') {
      assert.equal(result.outcome, 'rejected');
      assert.equal(result.error?.code, 'CODEX_USAGE_UNAVAILABLE');
      assert.equal(result.error?.retryable, false);
      assert.equal(typeof result.error?.usageRecoveryError, 'string');
      assert.equal(result.usageAccepted.length, 1);
      assert.equal(result.usageAccepted[0].reports[0].input_tokens, 10);
      assert.equal(terminal[0].kind, 'run_failed');
      assert.ok(terminal[0].at >= result.usageAttempts[1].failedAt);
    } else {
      assert.equal(result.outcome, 'resolved');
      assert.equal(result.result.completed, true);
      assert.equal(result.usageAccepted.length, 2);
      const last = result.usageAccepted.at(-1);
      assert.deepEqual(last.reports.map(({ input_tokens, output_tokens, cache_read_tokens, cumulative }) => ({ input_tokens, output_tokens, cache_read_tokens, cumulative })),
        [{ input_tokens: 12, output_tokens: 3, cache_read_tokens: 6, cumulative: true }]);
      assert.equal(terminal[0].kind, 'run_finished');
      assert.ok(result.settledAt >= last.acceptedAt && terminal[0].at >= last.acceptedAt);
      if (mode === 'slow') assert.ok(last.acceptedAt - result.usageAttempts[1].startedAt >= 2900, 'The asynchronous final sink was actually delayed');
    }
    if (mode === 'normal') {
      assert.ok(result.settledAt - evidence.clientExit.at < 1000, 'Normal close must not wait for the two-second fallback');
      assert.equal(evidence.descendant, null);
    } else {
      assert.equal(evidence.descendant?.nonce, nonce);
      assert.equal(status(evidence.descendant), 'alive', 'Inherited-pipe descendant must still exist before harness cleanup');
      assert.ok(result.settledAt - evidence.clientExit.at >= 1800, 'The inherited-pipe fallback must really be exercised');
    }
    evidence.assertion = { passed: true };
  } catch (error) {
    evidence.assertion = { passed: false, message: error.message, code: error.code ?? null };
    throw error;
  } finally {
    // An external observer cannot keep the isolated outer CLI alive. Capture
    // pre-cleanup state before terminating only nonce-bound fixture processes.
    evidence.beforeHarnessCleanup = { descendant: status(read(directory, 'descendant')), client: status(read(directory, 'client')) };
    try {
      if (outer.exitCode === null && outer.signalCode === null) outer.kill('SIGKILL');
      terminate(read(directory, 'descendant'), nonce);
      terminate(read(directory, 'client'), nonce);
      await Promise.race([closed.catch(() => {}), pause(500)]);
      const deadline = Date.now() + 1000;
      while (status(read(directory, 'descendant')) === 'alive' && Date.now() < deadline) await pause(25);
      evidence.afterHarnessCleanup = { descendant: status(read(directory, 'descendant')), client: status(read(directory, 'client')) };
      assert.notEqual(evidence.afterHarnessCleanup.descendant, 'alive', 'Fixture cleanup must terminate its descendant');
    } finally {
      evidence.networkAttempts = networkAttempts;
      evidence.finishedAt = Date.now();
      if (!evidence.assertion?.passed) t.diagnostic(JSON.stringify(evidence));
      assert.deepEqual(networkAttempts, []);
    }
  }
}

test('normal close promptly awaits the exact final checkpoint', { timeout: 18000 }, t => exercise(t, 'normal'));
test('parent exit releases inherited pipes through one exact final drain', { timeout: 18000 }, t => exercise(t, 'inherited'));
test('exit fallback awaits a slow final usage sink before terminal success', { timeout: 18000 }, t => exercise(t, 'slow'));
test('exit fallback preserves failed final accounting as a nonretryable pause', { timeout: 18000 }, t => exercise(t, 'failing'));
