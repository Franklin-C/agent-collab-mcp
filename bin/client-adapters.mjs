import { execFileSync, spawn } from 'node:child_process';

export const CLIENTS = {
  codex: { executable: 'codex', documentation: 'https://learn.chatgpt.com/docs/non-interactive-mode' },
  'claude-code': { executable: 'claude', documentation: 'https://code.claude.com/docs/en/headless' },
  'gemini-cli': { executable: 'gemini', documentation: 'https://geminicli.com/docs/cli/headless/' },
};

export function inspectClient(client, executable = CLIENTS[client]?.executable) {
  if (!CLIENTS[client]) throw new Error(`No unattended adapter for ${client}. Supported: ${Object.keys(CLIENTS).join(', ')}. GUI clients use MCP and manual wakeup.`);
  const helpArgs = client === 'codex' ? ['exec', '--help'] : ['--help'];
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const help = execFileSync(executable, helpArgs, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  const compatible = client === 'codex' ? /--json/.test(help) : /--output-format/.test(help);
  if (!compatible) throw new Error(`${client} lacks required structured output; update the client before supervising it.`);
  return { client, executable, version, resume: client === 'codex' ? /^\s+resume\s/m.test(help) : client === 'claude-code' && /--resume/.test(help), compatible };
}

export function invocation(capability, sessionId, options = {}) {
  if (sessionId && !/^[a-zA-Z0-9_-]{1,160}$/.test(sessionId)) throw new Error('Invalid client session identifier.');
  const model = options.model ? ['--model', options.model] : [];
  if (capability.client === 'codex') return { command: capability.executable, args: ['exec', ...(sessionId && capability.resume ? ['resume', sessionId] : ['--sandbox', options.write ? 'workspace-write' : 'read-only']), '--json', ...model, '-'] };
  if (capability.client === 'claude-code') return { command: capability.executable, args: ['--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', options.write ? 'acceptEdits' : 'dontAsk', ...(sessionId ? ['--resume', sessionId] : []), ...model] };
  if (capability.client === 'gemini-cli') return { command: capability.executable, args: ['--prompt', 'Process the Agent Collab event packet provided on stdin.', '--output-format', 'stream-json', '--approval-mode', options.write ? 'auto_edit' : 'default', ...(sessionId && capability.resume ? ['--resume', sessionId] : []), ...model] };
  throw new Error('Unsupported client.');
}

export function readClientEvent(line) {
  try {
    const raw = JSON.parse(line);
    const event = raw.msg ?? raw;
    const sessionId = event.session_id ?? (event.type === 'thread.started' ? event.thread_id : null);
    return { sessionId: typeof sessionId === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(sessionId) ? sessionId : null,
      failed: event.is_error === true || event.type === 'error' || event.type === 'turn.failed' || (event.type === 'result' && (event.error != null || event.status === 'error')),
      completed: event.type === 'result' || event.type === 'turn.completed' || event.type === 'task_complete' };
  } catch { return { sessionId: null, failed: false, completed: false }; }
}

/** No shell, unsafe approval bypass, global --latest session or token in argv. */
export async function runClient(capability, prompt, options = {}) {
  const call = invocation(capability, options.sessionId, options);
  return await new Promise((resolve, reject) => {
    const child = spawn(call.command, call.args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', sessionId = options.sessionId ?? null, failed = false, completed = false, bytes = 0, settled = false;
    const stop = () => { child.kill('SIGTERM'); setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 5000).unref(); };
    const timer = setTimeout(() => { failed = true; stop(); }, options.timeoutMs ?? 15 * 60000); timer.unref();
    options.signal?.addEventListener('abort', stop, { once: true });
    const consume = (line) => {
      const parsed = readClientEvent(line);
      try { options.onUsage?.(JSON.parse(line)); } catch { /* Non-JSON diagnostics are not usage. */ } sessionId = parsed.sessionId ?? sessionId; failed ||= parsed.failed; completed ||= parsed.completed;
      options.onSession?.(sessionId);
    };
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { failed = true; stop(); return; }
      options.onOutput?.(chunk);
      buffer += chunk.toString();
      let end; while ((end = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
    });
    child.stderr.on('data', chunk => { options.onDiagnostic?.(chunk); });
    child.on('error', error => { settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', stop); reject(error); });
    child.on('close', (code, signal) => {
      settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', stop);
      if (buffer) consume(buffer);
      if (code !== 0 || failed || !completed || options.signal?.aborted) reject(Object.assign(new Error(`${capability.client} turn did not complete (${signal ?? code}${failed ? ', provider error' : ''}). Events remain pending.`), { sessionId }));
      else resolve({ sessionId, completed, bytes });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    if (options.signal?.aborted) stop();
  });
}
