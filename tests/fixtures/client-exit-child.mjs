import './client-exit-network-guard.mjs';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode, directory, nonce] = process.argv.slice(2);
if (!['normal', 'inherited', 'slow', 'failing', 'descendant'].includes(mode) || !/^[a-f0-9-]{36}$/.test(nonce ?? '') || resolve(directory) !== directory) throw Error('Invalid isolated fixture arguments');
const sessionId = '01a08354-4c9d-7c90-becb-39b58bc8ca35';
function birth() {
  if (process.platform !== 'linux') return null;
  const text = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  return text.slice(text.lastIndexOf(')') + 2).split(' ')[19];
}
function record(name, details = {}) {
  const file = join(directory, `${name}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify({ nonce, pid: process.pid, birth: birth(), at: Date.now(), ...details }));
  renameSync(`${file}.tmp`, file);
}
const role = mode === 'descendant' ? 'descendant' : 'client';
record(role, { mode });
process.on('exit', code => record(`${role}-exit`, { code }));
// Every fixture process has a self-expiry even if the external harness fails.
setTimeout(() => process.exit(90), 15000);
if (mode === 'descendant') {
  process.send({ ready: true, nonce, pid: process.pid }, () => { if (process.connected) process.disconnect(); });
} else {
  const path = join(process.env.CODEX_HOME, 'sessions', '2026', '09', '08');
  mkdirSync(path, { recursive: true });
  const checkpoint = join(path, `rollout-2026-09-08T19-22-15-${sessionId}.jsonl`);
  const metadata = { type: 'session_meta', payload: { id: sessionId, session_id: sessionId, source: 'exec', cwd: directory } };
  writeFileSync(checkpoint, `${JSON.stringify(metadata)}\n`);
  const emit = () => {
    const usage = { input_tokens: 10, output_tokens: 2, cached_input_tokens: 4 };
    const text = `${JSON.stringify({ type: 'thread.started', thread_id: sessionId })}\n${JSON.stringify({ type: 'turn.completed', event_id: nonce, usage })}\n`;
    process.stdout.write(text, () => {
      // This final provider-shaped checkpoint is intentionally greater than
      // stdout, so the real normalizer's final read must be awaited.
      const totals = { input_tokens: 12, output_tokens: 3, cached_input_tokens: 6 };
      appendFileSync(checkpoint, `${JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'token_count', info: { total_token_usage: totals } } })}\n`);
      record('checkpoint-written', { totals });
      process.exit(0);
    });
  };
  if (mode === 'normal') emit();
  else {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'descendant', directory, nonce], {
      env: process.env, detached: true, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const readyDeadline = setTimeout(() => { record('descendant-readiness-failed'); child.kill('SIGKILL'); process.exit(91); }, 2000);
    child.once('error', error => { record('fixture-spawn-error', { code: error.code ?? null }); process.exit(92); });
    child.once('message', message => {
      if (!message?.ready || message.nonce !== nonce || message.pid !== child.pid) throw Error('Wrong fixture descendant identity');
      clearTimeout(readyDeadline); child.unref(); emit();
    });
  }
}
