import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { clientActivity, clientUsageActivity } from './activity.mjs';
import { codexConfigurationBinding, codexProfileName } from './codex-config.mjs';
import { createCodexUsageRecovery } from './codex-usage.mjs';

export const CLIENTS = {
  codex: { executable: 'codex', documentation: 'https://learn.chatgpt.com/docs/non-interactive-mode' },
  'claude-code': { executable: 'claude', documentation: 'https://code.claude.com/docs/en/headless' },
  'gemini-cli': { executable: 'gemini', documentation: 'https://geminicli.com/docs/cli/headless/' },
};

/** Capability declarations are not a successful enrollment or client certification. */
export function capabilityContract(capability) {
  const supported = Object.hasOwn(CLIENTS, capability?.client ?? '');
  return { version: 1, client: capability?.client ?? 'other', clientVersion: capability?.version ?? null,
    support: supported && capability?.compatible ? 'experimental' : 'manual',
    freshRuns: supported && capability?.compatible === true, resume: supported && capability?.resume === true,
    cancellation: supported, structuredResults: supported && capability?.compatible === true,
    usage: supported ? 'provider-reported-at-checkpoints' : 'unavailable',
    permissions: supported ? 'operator-scoped-enrollment-required' : 'client-managed',
    verifiedExecution: false };
}

/** Execute native programs or verified npm Node entrypoints directly; never feed a command string to cmd.exe. */
export function resolveClientExecutable(client, executable, options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') return { command: executable, prefixArgs: [] };
  const environment = options.env ?? process.env;
  const candidates = isAbsolute(executable) || executable.includes('/') || executable.includes('\\') ? [resolve(executable)]
    : (environment.PATH ?? environment.Path ?? '').split(delimiter).filter(Boolean).flatMap(directory => extname(executable) ? [join(directory, executable)] : ['.exe', '.cmd'].map(extension => join(directory, `${executable}${extension}`)));
  const selected = candidates.find(candidate => existsSync(candidate));
  if (!selected) throw new Error(`Cannot find ${client} executable. Install it or provide --executable with its full path.`);
  if (extname(selected).toLowerCase() === '.exe') return { command: selected, prefixArgs: [] };
  if (/\.[cm]?js$/i.test(selected)) return { command: process.execPath, prefixArgs: [selected] };
  const packageName = { codex: '@openai/codex', 'claude-code': '@anthropic-ai/claude-code', 'gemini-cli': '@google/gemini-cli' }[client];
  if (extname(selected).toLowerCase() === '.cmd' && packageName) {
    const packageRoot = join(dirname(selected), 'node_modules', ...packageName.split('/'));
    let manifest;
    try { manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')); } catch { /* Unsupported custom shell wrapper. */ }
    const entry = typeof manifest?.bin === 'string' ? manifest.bin : manifest?.bin?.[CLIENTS[client].executable];
    if (manifest?.name === packageName && typeof entry === 'string') {
      const path = resolve(packageRoot, entry), within = relative(packageRoot, path);
      if (within && !within.startsWith(`..${sep}`) && within !== '..' && !isAbsolute(within) && existsSync(path)) {
        if (/\.[cm]?js$/i.test(path)) return { command: process.execPath, prefixArgs: [path] };
        if (/\.exe$/i.test(path)) return { command: path, prefixArgs: [] };
      }
    }
  }
  throw new Error(`Cannot launch ${selected} without a shell. Provide --executable pointing to the client's native .exe or Node .js entrypoint.`);
}

export function inspectClient(client, executable = CLIENTS[client]?.executable) {
  if (!CLIENTS[client]) throw new Error(`No unattended adapter for ${client}. Supported: ${Object.keys(CLIENTS).join(', ')}. GUI clients use MCP and manual wakeup.`);
  const launch = resolveClientExecutable(client, executable);
  const helpArgs = client === 'codex' ? ['exec', '--help'] : ['--help'];
  const version = execFileSync(launch.command, [...launch.prefixArgs, '--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const help = execFileSync(launch.command, [...launch.prefixArgs, ...helpArgs], { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const compatible = client === 'codex' ? /--json/.test(help) : /--output-format/.test(help);
  if (!compatible) throw new Error(`${client} ${version} lacks required structured output; update the client or provide --executable for a compatible installation before supervising it.`);
  const versionParts = version.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  const profiles = client === 'codex' && /--profile/.test(help) && !!versionParts && (Number(versionParts[1]) > 0 || Number(versionParts[2]) >= 134);
  return { client, executable: launch.command, prefixArgs: launch.prefixArgs, version, profiles, resume: client === 'codex' ? /^\s+resume\s/m.test(help) : client === 'claude-code' && /--resume/.test(help), compatible };
}

function selectedProfile(capability, options) {
  const profile = codexProfileName(options.profile);
  if (profile && (capability.client !== 'codex' || !capability.profiles)) throw new Error('--profile requires Codex 0.134.0 or later with supported configuration profile files.');
  if (profile && !options.write) throw new Error('A Codex profile requires explicit --write enrollment; its permissions are selected by the operator.');
  return profile;
}
export function executionBinding(capability, options = {}) {
  const profile = selectedProfile(capability, options);
  return { version: 1, client: capability.client, clientVersion: capability.version ?? null,
    executable: capability.executable ?? null, prefixArgs: capability.prefixArgs ?? [], model: options.model ?? null,
    write: options.write === true,
    configuration: capability.client === 'codex' ? codexConfigurationBinding({ profile, env: options.env }) : null };
}
export function assertEnrollmentBinding(enrollment, capability, options = {}) {
  const profile = selectedProfile(capability, options);
  if (!enrollment?.execution && !profile) return null; // Existing unprofiled workers retain their prior enrollment contract.
  const current = executionBinding(capability, options);
  if (!enrollment?.verifiedAt || JSON.stringify(enrollment.execution) !== JSON.stringify(current)) throw Object.assign(new Error('The client, model, Codex home, profile, or configuration differs from verified enrollment. Rerun enrollment with the exact worker options.'), { code: 'ENROLLMENT_CHANGED', retryable: false });
  return current;
}

export function invocation(capability, sessionId, options = {}) {
  if (sessionId && !/^[a-zA-Z0-9_-]{1,160}$/.test(sessionId)) throw new Error('Invalid client session identifier.');
  const model = options.model ? ['--model', options.model] : [];
  const prefix = capability.prefixArgs ?? [];
  const profile = selectedProfile(capability, options);
  if (capability.client === 'codex') return { command: capability.executable, args: [...prefix, ...(profile ? ['--profile', profile] : []), 'exec', ...(sessionId && capability.resume ? ['resume', sessionId] : profile ? [] : ['--sandbox', options.write ? 'workspace-write' : 'read-only']), '--json', ...model, '-'] };
  if (capability.client === 'claude-code') return { command: capability.executable, args: [...prefix, '--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', options.write ? 'acceptEdits' : 'dontAsk', ...(sessionId ? ['--resume', sessionId] : []), ...model] };
  if (capability.client === 'gemini-cli') return { command: capability.executable, args: [...prefix, '--prompt', 'Process the Agent Collab event packet provided on stdin.', '--output-format', 'stream-json', '--approval-mode', options.write ? 'auto_edit' : 'default', ...(sessionId && capability.resume ? ['--resume', sessionId] : []), ...model] };
  throw new Error('Unsupported client.');
}

export function readClientEvent(line, client) {
  try {
    const raw = JSON.parse(line);
    const event = raw.msg ?? raw;
    const requiresApproval = event.type === 'item.completed' && event.item?.type === 'mcp_tool_call' && event.item.status === 'failed' &&
      /^MCP tool call requires approval, but approval policy is never\.?$/.test(event.item.error?.message ?? '');
    const authenticationHint = (!client || client === 'claude-code') && event.type === 'result' && typeof event.result === 'string' && /^Not logged in · Please run \/login\s*$/.test(event.result);
    const requiresAuthentication = authenticationHint && event.is_error === true;
    const sessionId = event.session_id ?? (event.type === 'thread.started' ? event.thread_id : null);
    return { sessionId: typeof sessionId === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(sessionId) ? sessionId : null,
      requiresApproval, requiresAuthentication, authenticationHint,
      failed: requiresApproval || requiresAuthentication || event.is_error === true || event.type === 'error' || event.type === 'turn.failed' || (event.type === 'result' && (event.error != null || event.status === 'error')),
      completed: event.type === 'result' || event.type === 'turn.completed' || event.type === 'task_complete' };
  } catch { return { sessionId: null, failed: false, completed: false }; }
}

/** Recognize only observed client diagnostics; never upload diagnostic text. */
export function readClientDiagnostic(client, text) {
  const lines = String(text).replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/);
  const authenticationHint = client === 'gemini-cli' && lines.some((line, index) => /^Please set an Auth method\b/.test(line) && /\bGEMINI_API_KEY\b/.test(lines.slice(index, index + 4).join(' ')));
  const requiresApproval = client === 'codex' && lines.some(line => {
    const plain = line.trim().replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/, '').replace(/\\"/g, '"');
    return plain.startsWith('ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: "Rejected("') && plain.endsWith(' rejected: blocked by policy")" }');
  });
  return { authenticationHint, requiresApproval };
}

/** No shell, unsafe approval bypass, global --latest session or token in argv. */
export async function runClient(capability, prompt, options = {}) {
  if (options.signal?.aborted) throw Object.assign(new Error('Client turn was cancelled before execution.'), { name: 'AbortError', retryable: false });
  const call = invocation(capability, options.sessionId, options);
  const usageRecovery = capability.client === 'codex' && options.onUsage ? createCodexUsageRecovery({ sessionId: options.sessionId, cwd: options.cwd ?? process.cwd(), env: options.env ?? process.env }) : null;
  return await new Promise((resolve, reject) => {
    const child = (options.spawn ?? spawn)(call.command, call.args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    let buffer = '', diagnosticBuffer = '', sessionId = options.sessionId ?? null, failed = false, requiresApproval = false, requiresAuthentication = false, authenticationHint = false, completed = false, bytes = 0, settled = false;
    const activity = event => { try { options.onActivity?.(event); } catch { /* Observation must never change execution results. */ } };
    activity({ kind: 'run_started' });
    const killTree = signal => {
      if (!child.pid || settled) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill(signal));
      } else { try { process.kill(-child.pid, signal); } catch { child.kill(signal); } }
    };
    const stop = () => { failed = true; killTree('SIGTERM'); setTimeout(() => killTree('SIGKILL'), 5000).unref(); };
    const timer = setTimeout(() => { failed = true; stop(); }, options.timeoutMs ?? 15 * 60000); timer.unref();
    options.signal?.addEventListener('abort', stop, { once: true });
    const consume = (line) => {
      const parsed = readClientEvent(line, capability.client);
      requiresApproval ||= parsed.requiresApproval === true;
      requiresAuthentication ||= parsed.requiresAuthentication === true;
      authenticationHint ||= parsed.authenticationHint === true;
      try {
        const raw = JSON.parse(line);
        usageRecovery?.observe(raw);
        try { options.onUsage?.(raw); } catch { /* A failed usage sink does not hide passive observations. */ }
        for (const event of [...clientActivity(capability.client, raw), ...clientUsageActivity(capability.client, raw)]) activity(event);
      } catch { /* Non-JSON diagnostics are not usage or activity. */ } sessionId = parsed.sessionId ?? sessionId; failed ||= parsed.failed; completed ||= parsed.completed;
      options.onSession?.(sessionId);
    };
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { failed = true; stop(); return; }
      options.onOutput?.(chunk);
      buffer += chunk.toString();
      let end; while ((end = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
    });
    child.stderr.on('data', chunk => {
      options.onDiagnostic?.(chunk);
      diagnosticBuffer = (diagnosticBuffer + chunk.toString()).slice(-16384);
      const parsed = readClientDiagnostic(capability.client, diagnosticBuffer);
      authenticationHint ||= parsed.authenticationHint;
      requiresApproval ||= parsed.requiresApproval;
    });
    child.on('error', error => { settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', stop); activity({ kind: 'run_failed' }); reject(error); });
    child.on('close', (code, signal) => {
      const alreadyFailed = settled;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', stop);
      if (buffer) consume(buffer);
      let usageRecoveryError;
      if (!alreadyFailed && usageRecovery && (code !== 0 || failed || !completed || requiresApproval || requiresAuthentication || options.signal?.aborted)) {
        try {
          const recovered = usageRecovery.recover();
          if (recovered) {
            options.onUsage(recovered);
            for (const event of clientUsageActivity(capability.client, recovered)) activity(event);
          }
        } catch { usageRecoveryError = 'Exact-session provider usage recovery was unavailable; no token estimate was substituted.'; }
      }
      requiresAuthentication ||= authenticationHint && (capability.client === 'gemini-cli' ? code === 41 : capability.client === 'claude-code' && typeof code === 'number' && code !== 0);
      failed ||= requiresApproval || requiresAuthentication;
      if (!alreadyFailed) activity({ kind: options.signal?.aborted ? 'run_stopped' : requiresAuthentication ? 'needs_authentication' : requiresApproval ? 'needs_permission' : code !== 0 || failed || !completed ? 'run_failed' : 'run_finished' });
      if (options.signal?.aborted) reject(Object.assign(new Error(`${capability.client} turn was cancelled. Events remain pending.`), { name: 'AbortError', retryable: false, sessionId, requiresApproval, requiresAuthentication, ...(usageRecoveryError ? { usageRecoveryError } : {}) }));
      else if (code !== 0 || failed || !completed) reject(Object.assign(new Error(requiresAuthentication ? `${capability.client} requires sign-in before unattended work can continue. ${capability.client === 'claude-code' ? 'Open Claude Code and run /login' : 'Configure authentication in Gemini CLI'}, then rerun enrollment. Events remain pending.` : requiresApproval ? `${capability.client} requires approval for its configured tools before unattended work can continue. Resolve the denied permission in the client, then rerun enrollment. Events remain pending.` : `${capability.client} turn did not complete (${signal ?? code}${failed ? ', provider error' : ''}). Events remain pending.`), { sessionId, requiresApproval, requiresAuthentication, ...(usageRecoveryError ? { usageRecoveryError } : {}) }));
      else resolve({ sessionId, completed, bytes });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    if (options.signal?.aborted) stop();
  });
}
