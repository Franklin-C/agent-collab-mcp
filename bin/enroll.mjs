import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { git, githubRepository, inside } from './worker.mjs';
import { capabilityContract, executionBinding, inspectClient, runClient } from './client-adapters.mjs';
import { createActivityReporter } from './activity.mjs';
import { createUsageCollector } from './usage.mjs';
import { acquireWorkerLock } from './worker-lock.mjs';

/** Runs a small real client probe. HTTP reachability alone never passes enrollment. */
export async function enroll(options) {
  const token = options.token ?? process.env.AGENT_COLLAB_TOKEN;
  if (!token || !options.write || !options.repo) throw new Error('Enrollment requires a token, --repo and explicit --write authorization for the verification task.');
  if (!options.model && (options.capability?.client ?? options.client) !== 'claude-code') throw new Error('Specify --model before enrollment so the real-client probe can report attributed usage.');
  const host = new URL(options.host);
  if (host.username || host.password || host.search || host.hash || host.pathname !== '/' || (host.protocol !== 'https:' && !(host.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)))) throw new Error('Enrollment requires an HTTPS origin or loopback development origin.');
  const repo = realpathSync(options.repo), repository = githubRepository(git(repo, ['remote', 'get-url', 'origin']));
  const capability = options.capability ?? inspectClient(options.client, options.executable);
  const execution = executionBinding(capability, options);
  const identity = createHash('sha256').update(`${options.host}:${token}:${repo}:${capability.client}`).digest('hex');
  const directory = resolve(options.state ?? join(homedir(), '.agent-collab', 'workers', identity.slice(0, 24)));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = acquireWorkerLock(directory, identity);
  try {
  const file = join(directory, 'state.json');
  const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { identity, workerId: randomUUID(), usage: [] };
  if (state.identity !== identity) throw new Error('Worker state belongs to another connection.');
  if (state.usageAttention) throw Object.assign(new Error('Enrollment is paused because exact provider usage could not be recovered. Reconcile the retained session and local usageAttention record before starting another paid probe.'), { code: 'WORKER_USAGE_ATTENTION', retryable: false });
  const persist = () => { writeFileSync(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 }); renameSync(`${file}.tmp`, file); };
  const request = async data => {
    const response = await (options.fetch ?? fetch)(`${options.host}/api/agent/worker`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ workerId: state.workerId, ...data }), redirect: 'error', signal: AbortSignal.timeout(20000) });
    let result;
    try { result = await response.json(); }
    catch (error) { if (response.ok) throw error; } // Malformed success still fails before the client probe.
    if (!response.ok) throw Object.assign(new Error(typeof result?.error === 'string' ? result.error : `Enrollment returned ${response.status}`), { status: response.status });
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Enrollment returned an invalid response object.');
    return result;
  };
  persist();
  await request({ action: 'register', label: options.label ?? `${capability.client} worker`, client: capability.client, write: true, version: capability.version });
  const challenge = await request({ action: 'challenge', repository });
  if (typeof challenge.challenge !== 'string' || !/^[a-f0-9-]{36}$/.test(challenge.challenge)) throw new Error('Invalid enrollment challenge.');
  const runId = randomUUID(), cwd = join(directory, 'enrollment', runId);
  if (!inside(directory, cwd)) throw new Error('Invalid enrollment directory.');
  mkdirSync(join(directory, 'enrollment'), { recursive: true });
  git(repo, ['worktree', 'add', '--detach', cwd, 'HEAD']);
  const proof = randomUUID(), proofName = `.ehgi-enrollment-${randomUUID()}`, activity = createActivityReporter({ statePath: join(directory, 'activity.json'), server: options.host, token, fetch: options.fetch });
  if (existsSync(join(cwd, proofName))) throw new Error('Enrollment proof file already exists.');
  let reportIndex = 0;
  const collectUsage = createUsageCollector(capability.client, options.model);
  let flushing, flushController;
  const flushUsage = signal => {
    if (flushing) return flushing;
    flushController = new AbortController();
    return flushing = (async () => {
    while (state.usage.length) {
      const response = await (options.fetch ?? fetch)(`${options.host}/api/usage/report`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(state.usage[0]), redirect: 'error', signal: AbortSignal.any([flushController.signal, ...(signal ? [signal] : []), AbortSignal.timeout(10000)]) });
      if (!response.ok) throw new Error('Enrollment usage delivery failed; usage retained for the worker to retry.');
      state.usage.shift(); persist();
    }
    })().finally(() => { flushing = null; flushController = null; });
  };
  try {
    const prompt = `This is an operator-authorized EhGI enrollment verification in a temporary Git worktree. Read AGENTS.md if present. Call get_briefing through the configured EhGI MCP server and obey stop_requested. Then call workforce_action with action "enrollment_verify" and input ${JSON.stringify({ workerId: state.workerId, challenge: challenge.challenge })}. Write exactly ${JSON.stringify(proof)} into ${proofName} using your file-edit tool, then read it back. Do not edit other files, claim tasks, open PRs, or change client permissions. Report any missing tools or approval requirement honestly and stop.`;
    lock.setPhase('client_active');
    try { await (options.runClient ?? runClient)(capability, prompt, { cwd, env: { ...(options.env ?? process.env), AGENT_COLLAB_TOKEN: token }, profile: options.profile, model: options.model, write: true, timeoutMs: 180000, signal: options.signal, onActivity: event => activity.record(event, { runId }), onUsage: raw => {
      for (const report of collectUsage(raw)) state.usage.push({ ...report, event_id: `${runId}-${reportIndex++}`, session_id: runId, phase: 'coordination', source: 'cli_stream' }); persist();
      void flushUsage().catch(() => {}); // Durable outbox retains failed deliveries.
    } }); } finally { lock.setPhase('idle'); }
    const proofPath = join(cwd, proofName);
    if (!existsSync(proofPath) || !lstatSync(proofPath).isFile() || lstatSync(proofPath).isSymbolicLink() || readFileSync(proofPath, 'utf8').trim() !== proof) throw new Error('The actual client did not complete its local file-edit probe.');
    if (reportIndex === 0) throw Object.assign(new Error('The actual client returned no measurable usage during enrollment. Inspect its structured usage adapter before starting paid work.'), { code: 'WORKER_USAGE_UNAVAILABLE', retryable: false });
    if (JSON.stringify(executionBinding(capability, options)) !== JSON.stringify(execution)) throw new Error('Codex configuration changed during enrollment, possibly from first-run trust initialization. Review the saved configuration and rerun the probe without resetting it.');
    const result = await request({ action: 'verify' });
    if (!result.verified) throw new Error('The hub did not verify the actual client MCP roundtrip.');
    state.enrollment = { verifiedAt: new Date().toISOString(), client: capability.client, version: capability.version, repository, execution, capabilities: { ...capabilityContract(capability), verifiedExecution: true } }; persist();
    return { verified: true, workerId: state.workerId, state: directory, capabilities: state.enrollment.capabilities, next: 'Start worker with the same --state and enable automatic assignments in Workforce. Enrollment proves this client/version can call MCP and edit locally; merge/deploy remain governed by project policy.' };
  } catch (error) {
    if (error.usageRecoveryError || ['CODEX_USAGE_UNAVAILABLE', 'WORKER_USAGE_UNAVAILABLE'].includes(error.code)) {
      state.usageAttention = { runId, recordedAt: new Date().toISOString(), reason: 'Exact-session provider usage was unavailable; no estimate was substituted.', ...(typeof error.sessionId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(error.sessionId) ? { sessionId: error.sessionId } : {}) }; persist();
    }
    throw error;
  } finally {
    const deadline = new AbortController();
    const timer = setTimeout(() => { deadline.abort(); flushController?.abort(); }, 5000);
    try {
      if (flushing) await flushing.catch(() => {});
      if (!deadline.signal.aborted) await flushUsage(deadline.signal).catch(() => {});
    } finally { clearTimeout(timer); }
    await activity.close().catch(() => {});
    // Retain the detached probe worktree as evidence; cleanup requires its own explicit action.
  }
  } finally { lock.release(); }
}
