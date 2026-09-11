import './client-exit-network-guard.mjs';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [role, directory, nonce, mode = 'parent'] = process.argv.slice(2);
if (!['client', 'descendant', 'sentinel'].includes(role) || !['parent', 'late'].includes(mode) || !/^[a-f0-9-]{36}$/.test(nonce ?? '') || resolve(directory) !== directory || process.platform === 'win32') throw Error('Invalid POSIX Stop fixture');
const sessionId = '01a08354-4c9d-7c90-becb-39b58bc8ca35';
const path = join(process.env.CODEX_HOME, 'sessions', '2026', '09', '08');
const checkpoint = join(path, `rollout-2026-09-08T19-22-15-${sessionId}.jsonl`);
function identity() {
  if (process.platform !== 'linux') return {};
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return { birth: fields[19], group: Number(fields[2]), session: Number(fields[3]) };
}
function record(name, details = {}) {
  const file = join(directory, `${name}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify({ nonce, pid: process.pid, at: Date.now(), ...identity(), ...details }));
  renameSync(`${file}.tmp`, file);
}
record(role);
process.on('exit', code => record(`${role}-exit`, { code }));
// Every synthetic process expires even if the external observer is interrupted.
setTimeout(() => process.exit(90), 15000);
if (role === 'sentinel') {
  // This unrelated process belongs to a different process group.
} else if (role === 'descendant') {
  const parentPid = process.ppid;
  const parentBirth = process.platform === 'linux' ? readFileSync(`/proc/${parentPid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19] : null;
  function parentStatus() {
    try {
      process.kill(parentPid, 0);
      if (process.platform === 'linux') {
        const stat = readFileSync(`/proc/${parentPid}/stat`, 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (fields[19] !== parentBirth) return 'reused';
        if (fields[0] === 'Z') return 'zombie';
      }
      return 'alive';
    } catch (error) { return ['ESRCH', 'ENOENT'].includes(error.code) ? 'absent' : 'unknown'; }
  }
  process.on('SIGTERM', () => {
    record('descendant-ignored-term');
    if (mode !== 'late') return;
    const deadline = Date.now() + 2000;
    const writeAfterParentExit = () => {
      const file = join(directory, 'client-exit.json'), state = parentStatus();
      const exited = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
      if (['absent', 'zombie', 'reused'].includes(state) && exited?.nonce === nonce && exited.pid === parentPid && exited.code === 0) {
        const totals = { input_tokens: 18, output_tokens: 5, cached_input_tokens: 9 };
        appendFileSync(checkpoint, `${JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'token_count', info: { total_token_usage: totals } } })}\n`);
        record('late-checkpoint-written', { totals, parentPid, parentObserved: state, parentExitedAt: exited.at });
      } else if (Date.now() < deadline) setTimeout(writeAfterParentExit, 25);
      else { record('late-checkpoint-parent-not-exited', { parentPid, parentObserved: state }); process.exit(93); }
    };
    // The writing process is the retained native descendant, not the outer
    // adapter or observer. It must establish parent termination before writing.
    setTimeout(writeAfterParentExit, 500);
  });
  process.send({ ready: true, nonce, pid: process.pid }, () => process.disconnect());
} else {
  mkdirSync(path, { recursive: true });
  writeFileSync(checkpoint, `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId, session_id: sessionId, source: 'exec', cwd: directory } })}\n`);
  process.on('SIGTERM', () => {
    const totals = { input_tokens: 12, output_tokens: 3, cached_input_tokens: 6 };
    appendFileSync(checkpoint, `${JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'token_count', info: { total_token_usage: totals } } })}\n`);
    record('checkpoint-written', { totals });
    process.exit(0);
  });
  const descendant = spawn(process.execPath, [fileURLToPath(import.meta.url), 'descendant', directory, nonce, mode], {
    env: process.env, detached: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const readyDeadline = setTimeout(() => { record('descendant-readiness-failed'); descendant.kill('SIGKILL'); process.exit(91); }, 2000);
  descendant.once('error', error => { record('fixture-spawn-error', { code: error.code ?? null }); process.exit(92); });
  descendant.once('message', message => {
    if (!message?.ready || message.nonce !== nonce || message.pid !== descendant.pid) throw Error('Wrong descendant identity');
    clearTimeout(readyDeadline);
    descendant.unref();
    const text = `${JSON.stringify({ type: 'thread.started', thread_id: sessionId })}\n${JSON.stringify({ type: 'turn.completed', event_id: nonce, usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 4 } })}\n`;
    process.stdout.write(text, () => process.stdout.write(`${JSON.stringify({ type: 'fixture.ready', nonce, descendantPid: descendant.pid })}\n`));
  });
}
