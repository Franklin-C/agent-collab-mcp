import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function processIsAbsent(pid, probe = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { probe(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

function locked(message) { return Object.assign(new Error(message), { code: 'WORKER_LOCKED', retryable: false }); }
function regularContents(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) throw locked('Worker lock is not a regular, bounded identity file. Retain it for inspection.');
  return readFileSync(path, 'utf8');
}

/** All current worker/enrollment/cleanup acquisitions share this short guard.
 * Recovery never mistakes an inaccessible or reused live PID for a dead owner.
 * A legacy numeric lock or interrupted guard requires operator inspection. */
export function acquireWorkerLock(directory, identity, options = {}) {
  if (typeof identity !== 'string' || !identity || identity.length > 512) throw new Error('Invalid worker lock identity.');
  const state = realpathSync(directory), file = join(state, 'worker.lock'), guard = join(state, 'worker.lock.guard');
  const nonce = randomUUID();
  let value = JSON.stringify({ version: 1, pid: process.pid, nonce, identity, phase: 'idle', acquiredAt: new Date().toISOString() });
  const marker = JSON.stringify({ pid: process.pid, nonce });
  try { writeFileSync(guard, marker, { flag: 'wx', mode: 0o600 }); }
  catch { throw locked(`Worker acquisition is locked at ${guard}. Verify its owner has stopped before removing an abandoned guard.`); }
  try {
    try { writeFileSync(file, value, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST' || !options.recoverStale) throw locked(`Worker is locked at ${file}. Stop its owner before retrying.`);
      const before = regularContents(file);
      let prior; try { prior = JSON.parse(before); } catch { throw locked('Legacy or invalid worker lock requires operator inspection.'); }
      if (prior?.version !== 1 || prior.phase !== 'idle' || prior.identity !== identity || typeof prior.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(prior.nonce) || !processIsAbsent(prior.pid, options.probe)) throw locked('Worker lock owner is live, interrupted during client execution, inaccessible, from another identity, or unverifiable. It was not removed.');
      if (regularContents(file) !== before) throw locked('Worker lock changed during recovery. It was not removed.');
      // The shared acquisition guard keeps another current runner from creating
      // a lock between this verified removal and our exclusive replacement.
      unlinkSync(file);
      writeFileSync(file, value, { flag: 'wx', mode: 0o600 });
    }
  } finally {
    if (regularContents(guard) === marker) unlinkSync(guard);
  }
  return {
    ownsDirectory(directory) { return realpathSync(directory) === state; },
    setPhase(phase) {
      if (!['idle', 'client_active'].includes(phase) || regularContents(file) !== value) throw locked('Worker lock ownership changed.');
      const next = JSON.stringify({ ...JSON.parse(value), phase });
      const temp = `${file}.${nonce}.tmp`;
      writeFileSync(temp, next, { flag: 'wx', mode: 0o600 });
      renameSync(temp, file); value = next;
    },
    isOwned() {
      try { return regularContents(file) === value; }
      catch { return false; }
    },
    release() {
      try { if (regularContents(file) === value) unlinkSync(file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
  };
}
