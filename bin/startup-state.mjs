import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { processIsAbsent } from './worker-lock.mjs';

function read(path) {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Startup recovery state requires inspection.');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function write(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  renameSync(temp, path);
}
function guarded(directory, run) {
  const state = realpathSync(directory), guard = join(state, 'startup.guard'), nonce = randomUUID();
  writeFileSync(guard, nonce, { flag: 'wx', mode: 0o600 });
  try { return run(join(state, 'startup-recovery.json')); }
  finally { if (readFileSync(guard, 'utf8') === nonce) unlinkSync(guard); }
}
function validate(value) {
  if (value && (value.version !== 1 || !['running', 'stopped', 'needs_attention'].includes(value.phase) || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !Number.isSafeInteger(value.crashes) || value.crashes < 0 || typeof value.nonce !== 'string')) throw new Error('Invalid startup recovery state; retain it for inspection.');
}

/** Native services restart abnormal exits. This durable ledger caps recovery
 * across process replacements and keeps Stop/auth/permission failures latched. */
export function beginStartupAttempt(directory, options = {}) {
  return guarded(directory, file => {
    const prior = read(file); validate(prior);
    if (prior && prior.phase !== 'running') return { allowed: false, phase: prior.phase, reason: 'Startup is paused. Repair the cause and explicitly reset recovery before starting it again.' };
    if (prior && !processIsAbsent(prior.pid, options.probe)) throw new Error('The previous startup process is live or unverifiable.');
    const crashes = prior ? prior.crashes + 1 : 0;
    const value = { version: 1, pid: process.pid, nonce: randomUUID(), crashes, phase: crashes > 3 ? 'needs_attention' : 'running', at: new Date().toISOString() };
    write(file, value);
    if (crashes > 3) return { allowed: false, phase: 'needs_attention', reason: 'Three process-crash recoveries were exhausted. Inspect the worker before resetting recovery.' };
    return {
      allowed: true, crashes,
      finish(phase) {
        if (!['stopped', 'needs_attention'].includes(phase)) throw new Error('Invalid terminal startup state.');
        return guarded(directory, path => {
          const current = read(path); validate(current);
          if (current?.nonce !== value.nonce || current.phase !== 'running') return false;
          write(path, { ...current, phase, at: new Date().toISOString() }); return true;
        });
      },
    };
  });
}

/** Explicit operator action; does not delete worker locks, resume jobs, change
 * credentials or start a process. Interrupted client work still needs review. */
export function resetStartupRecovery(directory, options = {}) {
  return guarded(directory, file => {
    const prior = read(file); validate(prior);
    if (prior && !processIsAbsent(prior.pid, options.probe)) throw new Error('Stop the existing startup process before resetting recovery.');
    const lock = read(join(realpathSync(directory), 'worker.lock'));
    if (lock && (lock.version !== 1 || lock.phase !== 'idle' || !processIsAbsent(lock.pid, options.probe))) throw new Error('An active or unverifiable worker/client lock requires inspection before recovery can be reset.');
    if (existsSync(file)) unlinkSync(file);
    return { reset: true, started: false, note: 'Recovery was reset. Start the registered user service or wait for the next login. No worker was launched.' };
  });
}
