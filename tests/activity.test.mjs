import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createActivityReporter, safeActivity, clientActivity, clientUsageActivity } from '../bin/activity.mjs';
import { capabilityContract, invocation, readClientDiagnostic, readClientEvent, resolveClientExecutable, runClient } from '../bin/client-adapters.mjs';

const response = acceptedThrough => new Response(JSON.stringify({ acceptedThrough }));
function setup(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ehgi-activity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { statePath: join(dir, 'activity.json'), server: 'http://localhost', token: 'test-token', now: () => Date.parse('2026-09-08T12:00:00Z'), ...extra };
}

test('collects only explicit metadata, never tool arguments, paths, messages or synthetic usage', () => {
  assert.deepEqual(safeActivity({ kind: 'tool_started', tool: 'command', command: 'print SECRET', token: 'SECRET', path: '/private' }), { kind: 'tool_started', tool: 'command' });
  assert.equal(safeActivity({ kind: 'usage_reported', text: '1000 tokens' }), null);
  assert.deepEqual(clientActivity('codex', { type: 'item.completed', item: { type: 'command_execution', command: 'secret', exit_code: 1 } }), [{ kind: 'tool_finished', tool: 'command', result: 'failed' }]);
  assert.deepEqual(clientActivity('claude-code', { type: 'assistant', message: { content: [{ type: 'text', text: 'Tests passed' }] } }), []);
  assert.deepEqual(clientActivity('gemini-cli', { type: 'tool_use', tool_name: 'SECRET' }), [{ kind: 'tool_started', tool: 'other' }]);
});

test('keeps provider-reported scope and totals without counting text', () => {
  assert.deepEqual(clientUsageActivity('codex', { type: 'turn.completed', usage: { input_tokens: 80, output_tokens: 10, cached_input_tokens: 40 } }), [{ kind: 'usage_reported', inputTokens: 80, outputTokens: 10, cachedInputTokens: 40, usageScope: 'turn' }]);
  assert.deepEqual(clientUsageActivity('claude-code', { type: 'result', modelUsage: { one: { inputTokens: 3, outputTokens: 2 }, two: { inputTokens: 5, outputTokens: 1 } } }), [{ kind: 'usage_reported', inputTokens: 8, outputTokens: 3, usageScope: 'run' }]);
  assert.deepEqual(clientUsageActivity('gemini-cli', { type: 'result', stats: { input_tokens: -1, output_tokens: 5 } }), []);
  assert.deepEqual(clientUsageActivity('codex', { type: 'turn.completed', text: 'generated output' }), []);
});

test('retains failed deliveries on disk and retries stable event sequences after restart', async t => {
  let attempts = 0, first;
  const options = setup(t, { fetch: async (_url, request) => { const packet = JSON.parse(request.body); first ??= packet; if (++attempts === 1) throw new Error('offline'); return response(packet.events.at(-1).sequence); } });
  const reporter = createActivityReporter(options);
  reporter.record({ kind: 'run_started', raw: 'SECRET' }, { runId: 'run-1', taskId: 'task-1' });
  await assert.rejects(reporter.flush(), /offline/);
  assert.equal(JSON.parse(readFileSync(options.statePath)).pending.length, 1);
  // Closing models process shutdown while offline; retries remain persisted.
  options.fetch = async () => { throw new Error('offline'); };
  await reporter.close().catch(() => {});
  let replay;
  const restarted = createActivityReporter({ ...options, fetch: async (_url, request) => { replay = JSON.parse(request.body); return response(replay.events.at(-1).sequence); } });
  await restarted.close();
  assert.deepEqual(replay, first);
  assert.equal(JSON.parse(readFileSync(options.statePath)).pending.length, 0);
  assert(!JSON.stringify(replay).includes('SECRET'));
});

test('never drops queued events on invalid acknowledgements or capacity overflow', async t => {
  const errors = [];
  const options = setup(t, { maxPending: 1, onError: error => errors.push(error), fetch: async () => response(1000) });
  const reporter = createActivityReporter(options);
  assert.equal(reporter.record({ kind: 'run_started' }, { runId: 'one' }), true);
  assert.equal(reporter.record({ kind: 'tool_started' }, { runId: 'one' }), false);
  await assert.rejects(reporter.flush(), /Invalid activity acknowledgement/);
  await reporter.close().catch(() => {});
  const state = JSON.parse(readFileSync(options.statePath));
  assert.equal(state.pending.length, 1); assert.equal(state.nextSequence, 2); assert.equal(errors.length, 1);
});

test('serializes overlapping flushes and preserves newly recorded events', async t => {
  let release, calls = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const options = setup(t, { fetch: async (_url, request) => { calls++; const packet = JSON.parse(request.body); if (calls === 1) await waiting; return response(packet.events.at(-1).sequence); } });
  const reporter = createActivityReporter(options);
  reporter.record({ kind: 'run_started' }, { runId: 'one' });
  const first = reporter.flush(), second = reporter.flush();
  assert.equal(first, second);
  reporter.record({ kind: 'tool_started' }, { runId: 'one' }); release();
  await first; await reporter.close();
  assert.equal(calls, 2); assert.deepEqual(JSON.parse(readFileSync(options.statePath)).pending, []);
});

test('binds saved state to its connection and refuses insecure reporting endpoints', async t => {
  const options = setup(t, { fetch: async () => response(1) });
  const reporter = createActivityReporter(options); await reporter.close();
  assert.throws(() => createActivityReporter({ ...options, token: 'different-token' }), /another connection/);
  assert.throws(() => createActivityReporter({ ...options, server: 'http://example.com' }), /HTTPS/);
  assert.throws(() => createActivityReporter({ ...options, server: 'https://user:secret@example.com' }), /safe server URL/);
});

test('real child lifecycle observations remain separate from raw output and billing callbacks', async t => {
  const options = setup(t);
  const executable = join(options.statePath, '..', 'fixture.cjs');
  writeFileSync(executable, `console.log(JSON.stringify({type:'item.started',item:{type:'command_execution',command:'SECRET'}})); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:9,output_tokens:2}}));`);
  const observed = [];
  await runClient({ client: 'codex', executable }, 'private prompt', { spawn: (_command, _args, options) => spawn(process.execPath, [executable], options), onActivity: event => observed.push(event) });
  assert.deepEqual(observed.map(event => event.kind), ['run_started', 'tool_started', 'usage_reported', 'run_finished']);
  assert(!JSON.stringify(observed).includes('SECRET'));
});

test('Windows npm shims resolve a known package entrypoint without executing the shell wrapper', t => {
  const options = setup(t), bin = join(options.statePath, '..');
  const root = join(bin, 'node_modules', '@google', 'gemini-cli'); mkdirSync(root, { recursive: true });
  writeFileSync(join(bin, 'gemini.cmd'), '@echo never execute this shell wrapper');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@google/gemini-cli', bin: { gemini: 'index.js' } }));
  writeFileSync(join(root, 'index.js'), '');
  const launch = resolveClientExecutable('gemini-cli', 'gemini', { platform: 'win32', env: { PATH: bin } });
  assert.deepEqual(launch, { command: process.execPath, prefixArgs: [join(root, 'index.js')] });
  const call = invocation({ client: 'gemini-cli', executable: launch.command, prefixArgs: launch.prefixArgs }, null);
  assert.equal(call.args[0], join(root, 'index.js')); assert(!call.args.includes('cmd.exe'));
  writeFileSync(join(root, 'native.exe'), 'fixture');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@google/gemini-cli', bin: { gemini: 'native.exe' } }));
  assert.deepEqual(resolveClientExecutable('gemini-cli', 'gemini', { platform: 'win32', env: { PATH: bin } }), { command: join(root, 'native.exe'), prefixArgs: [] });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@google/gemini-cli', bin: { gemini: '../../../../outside.js' } }));
  assert.throws(() => resolveClientExecutable('gemini-cli', 'gemini', { platform: 'win32', env: { PATH: bin } }), /without a shell/);
});

test('Windows native and explicit Node entrypoints work while custom shell wrappers require an explicit target', t => {
  const options = setup(t), bin = join(options.statePath, '..');
  writeFileSync(join(bin, 'claude.exe'), 'fixture'); writeFileSync(join(bin, 'custom.cmd'), 'fixture'); writeFileSync(join(bin, 'custom.mjs'), 'fixture');
  assert.deepEqual(resolveClientExecutable('claude-code', 'claude', { platform: 'win32', env: { PATH: bin } }), { command: join(bin, 'claude.exe'), prefixArgs: [] });
  assert.deepEqual(resolveClientExecutable('codex', join(bin, 'custom.mjs'), { platform: 'win32' }), { command: process.execPath, prefixArgs: [join(bin, 'custom.mjs')] });
  assert.throws(() => resolveClientExecutable('codex', join(bin, 'custom.cmd'), { platform: 'win32' }), /without a shell/);
});

test('capabilities distinguish adapter support from verified execution', () => {
  assert.equal(capabilityContract({ client: 'codex', compatible: true, version: '1' }).support, 'experimental');
  assert.equal(capabilityContract({ client: 'codex', compatible: true }).verifiedExecution, false);
  assert.equal(capabilityContract({ client: 'cursor' }).freshRuns, false);
  assert.equal(capabilityContract({ client: 'cursor' }).support, 'manual');
});

async function diagnosticClient(t, client, stdout, stderr, code) {
  const options = setup(t), executable = join(options.statePath, '..', 'diagnostic.cjs'), observed = [];
  writeFileSync(executable, `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode=${code};`);
  const result = runClient({ client, executable }, 'fixture prompt', { spawn: (_command, _args, options) => spawn(process.execPath, [executable], options), onActivity: event => observed.push(event) });
  return { result, observed };
}

test('actual Claude login failure is typed while a successful answer quoting it is not', async t => {
  const event = { type: 'result', result: 'Not logged in · Please run /login' };
  assert.equal(readClientEvent(JSON.stringify({ ...event, is_error: true }), 'claude-code').requiresAuthentication, true);
  const blocked = await diagnosticClient(t, 'claude-code', JSON.stringify(event), '', 1);
  await assert.rejects(blocked.result, error => error.requiresAuthentication === true && /run \/login/.test(error.message));
  assert.equal(blocked.observed.at(-1).kind, 'needs_authentication');
  const quote = await diagnosticClient(t, 'claude-code', JSON.stringify(event), '', 0);
  await quote.result;
  assert.equal(quote.observed.at(-1).kind, 'run_finished');
});

test('actual Gemini auth diagnostic plus exit41 yields safe sign-in guidance without uploading raw paths', async t => {
  const diagnostic = 'Please set an Auth method in your /PRIVATE/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA\n';
  const blocked = await diagnosticClient(t, 'gemini-cli', '', diagnostic, 41);
  await assert.rejects(blocked.result, error => error.requiresAuthentication === true && !/PRIVATE|GEMINI_API_KEY/.test(error.message));
  assert.deepEqual(blocked.observed.at(-1), { kind: 'needs_authentication' });
  assert(!JSON.stringify(blocked.observed).includes('PRIVATE'));
  const unrelated = await diagnosticClient(t, 'gemini-cli', '', diagnostic, 1);
  await assert.rejects(unrelated.result, error => error.requiresAuthentication === false);
  assert.equal(readClientDiagnostic('gemini-cli', 'Docs mention GEMINI_API_KEY but this is not an auth failure.').authenticationHint, false);
});

test('exact Codex router policy rejection is typed but arbitrary policy prose is ignored', async t => {
  const diagnostic = 'ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: "Rejected(\\"`powershell.exe -Command SECRET` rejected: blocked by policy\\")" }';
  assert.equal(readClientDiagnostic('codex', diagnostic).requiresApproval, true);
  assert.equal(readClientDiagnostic('codex', 'An example command was rejected: blocked by policy').requiresApproval, false);
  assert.equal(readClientDiagnostic('claude-code', diagnostic).requiresApproval, false);
  const blocked = await diagnosticClient(t, 'codex', JSON.stringify({ type: 'turn.completed' }), diagnostic, 0);
  await assert.rejects(blocked.result, error => error.requiresApproval === true && !error.message.includes('SECRET'));
  assert.deepEqual(blocked.observed.at(-1), { kind: 'needs_permission' });
});
