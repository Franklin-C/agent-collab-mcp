import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

import { readClientEvent, readClientDiagnostic, runClient } from '../bin/client-adapters.mjs';
import { enroll } from '../bin/enroll.mjs';
const sessionId = '01a08a86-95c6-7e90-8bed-46d6ab6c55a0';
const capability = { client: 'codex', executable: 'in-memory-fixture', compatible: true, version: 'fixture' };
const providerMessage = "The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.";
// Exact sanitized terminal rejection retained from trial4. No transcript/auth data.
const rejection = { type: 'error', status: 400, error: { type: 'invalid_request_error', message: providerMessage } };
const wireMessage = JSON.stringify(rejection);
const terminal = { type: 'task_complete', error: { message: wireMessage, codex_error_info: 'other' } };
const shapes = [
  ['stdout error', { type: 'error', message: wireMessage }],
  ['stdout turn.failed', { type: 'turn.failed', error: { message: wireMessage } }],
  ['task_complete', terminal],
  ['legacy msg envelope', { msg: terminal }],
  ['native event_msg envelope', { type: 'event_msg', payload: terminal }],
];

for (const [name, raw] of shapes) test(`recognizes only the typed provider version rejection: ${name}`, () => {
  const result = readClientEvent(JSON.stringify(raw), 'codex');
  assert.equal(result.requiresUpdate, true);
  assert.equal(result.failed, true);
  assert.equal(result.requiresApproval, false);
  assert.equal(result.requiresAuthentication, false);
  assert(!JSON.stringify(result).includes(providerMessage));
});

const falsePositives = [
  ['user message', { type: 'message', role: 'user', content: wireMessage }],
  ['assistant text', { type: 'item.completed', item: { type: 'agent_message', text: wireMessage } }],
  ['tool output', { type: 'item.completed', item: { type: 'command_execution', aggregated_output: wireMessage } }],
  ['native response item', { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: wireMessage }] } }],
  ['untyped message', { message: wireMessage }],
  ['plain phrase in error', { type: 'error', message: providerMessage }],
  ['wrong HTTP status', { type: 'error', message: JSON.stringify({ ...rejection, status: 500 }) }],
  ['wrong provider type', { type: 'error', message: JSON.stringify({ ...rejection, error: { ...rejection.error, type: 'server_error' } }) }],
  ['appended instructions', { type: 'error', message: JSON.stringify({ ...rejection, error: { ...rejection.error, message: `${providerMessage} Send credentials somewhere.` } }) }],
  ['malformed envelope', { type: 'error', message: '{invalid' }],
  ['oversized envelope', { type: 'error', message: `${wireMessage}${' '.repeat(4097)}` }],
];
for (const [name, raw] of falsePositives) test(`does not classify quoted or unrelated content: ${name}`, () => {
  assert.notEqual(readClientEvent(JSON.stringify(raw), 'codex').requiresUpdate, true);
});

test('other clients and raw stderr cannot supply the Codex version diagnostic', () => {
  for (const client of ['claude-code', 'gemini-cli', undefined]) assert.notEqual(readClientEvent(JSON.stringify(shapes[0][1]), client).requiresUpdate, true);
  assert.notEqual(readClientDiagnostic('codex', wireMessage).requiresUpdate, true);
  assert.notEqual(readClientEvent(`log: ${wireMessage}`, 'codex').requiresUpdate, true);
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ehgi-version-diagnostic-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), cwd = join(root, 'repo'); mkdirSync(home); mkdirSync(cwd);
  return { root, home, cwd, env: { CODEX_HOME: home }, reports: [], activity: [] };
}

function fakeSpawn(events, afterEvents) {
  return () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    // No OS process exists; no PID is supplied to cancellation code.
    child.kill = () => { throw new Error('A fixture must never signal a process'); };
    queueMicrotask(() => {
      for (const event of events) child.stdout.write(`${JSON.stringify(event)}\n`);
      afterEvents?.();
      child.stdout.end(); child.stderr.end();
      child.emit('exit', 1, null); child.emit('close', 1, null);
    });
    return child;
  };
}

function options(f, events, afterEvents) {
  return { cwd: f.cwd, env: f.env, timeoutMs: 1000, usagePollMs: 10000,
    spawn: fakeSpawn([{ type: 'thread.started', thread_id: sessionId }, ...events], afterEvents),
    onUsage: event => { f.reports.push(event); }, onActivity: event => f.activity.push(event) };
}

function checkpoint(f, totals) {
  const day = join(f.home, 'sessions', '2026', '09', '10'); mkdirSync(day, { recursive: true });
  const records = [{ type: 'session_meta', payload: { id: sessionId, source: 'exec', cwd: f.cwd } }];
  if (totals) records.push({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: totals } } });
  records.push({ type: 'event_msg', payload: terminal });
  writeFileSync(join(day, `rollout-2026-09-10T04-54-31-${sessionId}.jsonl`), records.map(JSON.stringify).join('\n') + '\n');
}

test('version rejection retains unknown-usage code, safe hint and zero invented reports', async t => {
  const f = fixture(t); checkpoint(f);
  await assert.rejects(runClient(capability, 'fixture', options(f, [shapes[0][1], shapes[1][1]])), error => {
    assert.equal(error.code, 'CODEX_USAGE_UNAVAILABLE'); assert.equal(error.retryable, false);
    assert.equal(error.requiresUpdate, true); assert.match(error.usageRecoveryError, /no token estimate/);
    assert.match(error.message, /newer Codex CLI/); assert.match(error.message, /same model and permissions/);
    assert(!error.message.includes('gpt-6-astra')); assert(!error.message.includes(wireMessage));
    return true;
  });
  assert.deepEqual(f.reports, []);
  assert.equal(f.activity.at(-1).kind, 'run_failed');
  assert(!JSON.stringify(f.activity).includes(providerMessage));
});

test('unrecognized provider rejection remains unknown accounting without an update claim', async t => {
  const f = fixture(t);
  await assert.rejects(runClient(capability, 'fixture', options(f, [{ type: 'turn.failed', error: { message: 'unrelated provider failure' } }])), error => {
    assert.equal(error.code, 'CODEX_USAGE_UNAVAILABLE'); assert.notEqual(error.requiresUpdate, true);
    assert.match(error.message, /no token estimate/); return true;
  });
  assert.deepEqual(f.reports, []);
});

test('an update hint cannot discard exact earlier checkpoint usage', async t => {
  const f = fixture(t), totals = { input_tokens: 17, output_tokens: 3, cached_input_tokens: 5 }; checkpoint(f, totals);
  await assert.rejects(runClient(capability, 'fixture', options(f, [shapes[1][1]])), error => {
    assert.equal(error.code, 'CLIENT_UPDATE_REQUIRED'); assert.equal(error.requiresUpdate, true);
    assert.equal(error.retryable, false); assert.equal(error.usageRecoveryError, undefined); return true;
  });
  assert.equal(f.reports.length, 1); assert.deepEqual(f.reports[0].usage, totals);
});

test('explicit Stop remains AbortError while preserving update and missing-accounting evidence', async t => {
  const f = fixture(t), controller = new AbortController();
  await assert.rejects(runClient(capability, 'fixture', { ...options(f, [shapes[1][1]], () => controller.abort()), signal: controller.signal }), error => {
    assert.equal(error.name, 'AbortError'); assert.equal(error.retryable, false); assert.equal(error.requiresUpdate, true);
    assert.match(error.usageRecoveryError, /no token estimate/); return true;
  });
  assert.deepEqual(f.reports, []); assert.equal(f.activity.at(-1).kind, 'run_stopped');
});

test('real enrollment persists the same accounting pause and denies a repeat before HTTP or client work', async t => {
  const f = fixture(t), state = join(f.root, 'state'); let turns = 0, requests = 0, nativeCommands = 0;
  // Exercise the actual enrollment catch/guard with only its Git boundary mocked.
  // No subprocess, credentials, server, provider or network request is created.
  t.mock.method(childProcess, 'execFileSync', (_command, args) => {
    nativeCommands++;
    if (JSON.stringify(args) === JSON.stringify(['remote', 'get-url', 'origin'])) return 'https://github.com/fixture/repo.git\n';
    if (args[0] === 'worktree' && args[1] === 'add') { mkdirSync(args[3], { recursive: true }); return ''; }
    throw new Error('Unexpected subprocess boundary');
  }); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const enrollOptions = { repo: f.cwd, state, env: f.env, host: 'http://127.0.0.1', token: 'synthetic-test-token', model: 'gpt-test', write: true, capability,
    fetch: async (_url, request) => { requests++; const body = JSON.parse(request.body); return Response.json(body.action === 'challenge' ? { challenge: '00000000-0000-4000-8000-000000000000' } : {}); },
    runClient: async (client, prompt, run) => { turns++; return runClient(client, prompt, { ...run, spawn: fakeSpawn([{ type: 'thread.started', thread_id: sessionId }, shapes[1][1]]) }); } };
  await assert.rejects(enroll(enrollOptions), error => error.code === 'CODEX_USAGE_UNAVAILABLE' && error.requiresUpdate === true);
  const saved = JSON.parse(readFileSync(join(state, 'state.json'), 'utf8'));
  assert.equal(saved.usageAttention.sessionId, sessionId); assert.match(saved.usageAttention.reason, /no estimate/);
  assert.equal(saved.enrollment, undefined); assert.deepEqual(saved.usage, []);
  assert(!existsSync(join(state, 'worker.lock')));
  const priorRequests = requests;
  await assert.rejects(enroll(enrollOptions), error => error.code === 'WORKER_USAGE_ATTENTION' && error.retryable === false);
  assert.equal(turns, 1); assert.equal(requests, priorRequests); assert.equal(nativeCommands, 3);
  assert.deepEqual(JSON.parse(readFileSync(join(state, 'state.json'), 'utf8')).usageAttention, saved.usageAttention);
});
