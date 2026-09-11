import { networkAttempts } from './fixtures/client-exit-network-guard.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(fileURLToPath(import.meta.url));
const pause = ms => new Promise(done => setTimeout(done, ms));
function read(directory, name) {
  const file = join(directory, `${name}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}
function status(record) {
  if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 0) return 'unknown';
  try {
    process.kill(record.pid, 0);
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${record.pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (record.birth && fields[19] !== record.birth) return 'reused';
      if (fields[0] === 'Z') return 'zombie';
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

for (const mode of ['parent', 'late']) test(`POSIX Stop outlives parent settlement, kills its group and awaits ${mode === 'late' ? 'a late descendant checkpoint' : 'exact final usage'}`, {
  timeout: 20000, skip: process.platform === 'win32' ? 'Windows taskkill is a separate process-tree path' : false,
}, async t => {
  const nonce = randomUUID(), parent = resolve(tmpdir()), directory = mkdtempSync(join(parent, 'agent-collab-client-stop-'));
  t.after(() => {
    const target = resolve(directory); assert.equal(dirname(target), parent); assert.ok(basename(target).startsWith('agent-collab-client-stop-'));
    rmSync(target, { recursive: true, force: true });
  });
  const env = Object.fromEntries(Object.entries({ PATH: process.env.PATH, HOME: directory, USERPROFILE: directory,
    TMPDIR: directory, TMP: directory, TEMP: directory, CODEX_HOME: join(directory, 'codex-home'),
  }).filter(([, value]) => value !== undefined));
  const evidence = { nonce, mode, platform: process.platform, node: process.version, startedAt: Date.now() };
  const sentinel = spawn(process.execPath, [join(root, 'fixtures/client-stop-child.mjs'), 'sentinel', directory, nonce], { env, detached: true, stdio: 'ignore' });
  let sentinelError, outer, closed;
  sentinel.once('error', error => { sentinelError = error; });
  try {
    const deadline = Date.now() + 2500;
    while (!read(directory, 'sentinel')) {
      if (sentinelError) throw sentinelError;
      if (Date.now() >= deadline) throw Error('Sentinel did not become ready');
      await pause(25);
    }
    evidence.sentinel = read(directory, 'sentinel');
    assert.equal(evidence.sentinel.pid, sentinel.pid); assert.equal(evidence.sentinel.nonce, nonce);
    outer = spawn(process.execPath, [join(root, 'fixtures/client-stop-outer.mjs'), directory, nonce, mode], { env, stdio: 'ignore' });
    closed = exitOf(outer, 10000);
    evidence.outer = await closed;
    evidence.result = read(directory, 'outer-result'); evidence.nativeExit = read(directory, 'outer-exit');
    evidence.client = read(directory, 'client'); evidence.clientExit = read(directory, 'client-exit');
    evidence.descendant = read(directory, 'descendant'); evidence.ignoredTerm = read(directory, 'descendant-ignored-term');
    evidence.parentCheckpoint = read(directory, 'checkpoint-written'); evidence.lateCheckpoint = read(directory, 'late-checkpoint-written');
    assert.equal(evidence.outer.code, 0); assert.equal(evidence.nativeExit?.nonce, nonce);
    assert.equal(evidence.clientExit?.code, 0, 'The real synthetic parent exits zero on TERM');
    const result = evidence.result;
    assert.equal(result?.nonce, nonce); assert.equal(result.outcome, 'rejected'); assert.equal(result.error.name, 'AbortError');
    assert.equal(result.error.retryable, false); assert.equal(result.error.usageRecoveryError, null);
    assert.equal(result.descendantPid, evidence.descendant?.pid); assert.equal(evidence.ignoredTerm?.nonce, nonce);
    assert.deepEqual(result.networkAttempts, []);
    if (process.platform === 'linux') {
      assert.equal(evidence.client.group, evidence.client.pid); assert.equal(evidence.descendant.group, evidence.client.group);
      assert.equal(evidence.descendant.session, evidence.client.session); assert.notEqual(evidence.sentinel.group, evidence.client.group);
    }
    const terminal = result.activity.filter(event => ['run_finished', 'run_failed', 'run_stopped'].includes(event.kind));
    assert.deepEqual(terminal.map(event => event.kind), ['run_stopped']);
    assert.equal(result.usageAttempts.length, 2); assert.equal(new Set(result.usageAttempts.map(item => item.id)).size, 2);
    assert.equal(result.usageAccepted.length, 2);
    const last = result.usageAccepted.at(-1);
    if (mode === 'late') {
      assert.equal(evidence.parentCheckpoint?.nonce, nonce); assert.equal(evidence.parentCheckpoint.totals.input_tokens, 12);
      assert.equal(evidence.lateCheckpoint?.nonce, nonce); assert.equal(evidence.lateCheckpoint.pid, evidence.descendant.pid);
      assert.equal(evidence.lateCheckpoint.parentPid, evidence.client.pid);
      assert.ok(['absent', 'zombie', 'reused'].includes(evidence.lateCheckpoint.parentObserved));
      assert.ok(evidence.lateCheckpoint.at > evidence.clientExit.at && evidence.lateCheckpoint.at > evidence.parentCheckpoint.at);
      assert.ok(evidence.lateCheckpoint.at < result.stopAt + 4500, 'Retained descendant writes before the five-second SIGKILL');
    }
    assert.deepEqual(last.reports.map(({ input_tokens, output_tokens, cache_read_tokens, cumulative }) => ({ input_tokens, output_tokens, cache_read_tokens, cumulative })),
      [mode === 'late' ? { input_tokens: 18, output_tokens: 5, cache_read_tokens: 9, cumulative: true } : { input_tokens: 12, output_tokens: 3, cache_read_tokens: 6, cumulative: true }]);
    if (mode === 'late') assert.ok(evidence.lateCheckpoint.at < result.usageAttempts.at(-1).startedAt, 'The sole final read must follow the late checkpoint');
    assert.ok(last.acceptedAt - result.usageAttempts.at(-1).startedAt >= 2900);
    assert.ok(result.settledAt >= last.acceptedAt && terminal[0].at >= last.acceptedAt);
    evidence.statusAtOuterExit = { at: Date.now(), descendant: status(evidence.descendant), sentinel: status(evidence.sentinel) };
    // Only this external observer waits beyond the five-second production
    // escalation. It cannot keep the already isolated outer CLI alive.
    await pause(Math.max(0, result.stopAt + 5750 - Date.now()));
    evidence.afterEscalation = { at: Date.now(), descendant: status(evidence.descendant), sentinel: status(evidence.sentinel) };
    assert.equal(evidence.afterEscalation.sentinel, 'alive', 'Unrelated sentinel must survive');
    assert.ok(['absent', 'zombie'].includes(evidence.afterEscalation.descendant), 'Owned descendant must be terminated before any harness cleanup');
    assert.ok(result.settledAt - result.stopAt >= 4800, 'Stop must wait for its own escalation obligation');
    evidence.assertion = { passed: true };
  } catch (error) {
    evidence.assertion = { passed: false, message: error.message, code: error.code ?? null }; throw error;
  } finally {
    evidence.beforeHarnessCleanup = { descendant: status(read(directory, 'descendant')), sentinel: status(read(directory, 'sentinel')) };
    if (outer && outer.exitCode === null && outer.signalCode === null) outer.kill('SIGKILL');
    terminate(read(directory, 'descendant'), nonce); terminate(read(directory, 'client'), nonce);
    if (sentinel.exitCode === null && sentinel.signalCode === null) sentinel.kill('SIGKILL');
    await Promise.race([closed?.catch(() => {}), pause(500)]);
    evidence.finishedAt = Date.now(); evidence.networkAttempts = networkAttempts;
    t.diagnostic(JSON.stringify(evidence));
    assert.deepEqual(networkAttempts, []);
  }
});
