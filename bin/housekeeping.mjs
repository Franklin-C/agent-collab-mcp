import { cleanupLocalWorktrees } from './cleanup.mjs';
import { appendFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { assertRepositoryOrigin } from './repository.mjs';

const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const valid = item => item && id(item.jobId) && Number.isSafeInteger(item.fence) && item.fence > 0 && item.branch === `workforce/${item.jobId}-${item.fence}`;
export const MAX_HOUSEKEEPING_PENDING = 100;
const archiveName = 'housekeeping-retained.jsonl';

function archive(state, directory, records) {
  if (!records.length) return;
  if (!directory) throw new Error('A private worker directory is required to archive retained cleanup metadata.');
  const path = join(realpathSync(directory), archiveName);
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Housekeeping archive requires a regular file. Work was retained.');
  }
  appendFileSync(path, records.map(record => JSON.stringify({ at: new Date().toISOString(), ...record, files: 'unchanged' }) + '\n').join(''), { mode: 0o600 });
  state.housekeeping.archivedCount = (state.housekeeping.archivedCount ?? 0) + records.length;
  state.housekeeping.retentionArchive = archiveName;
}
function bounded(state, pending, directory) {
  const overflow = Math.max(0, pending.length - MAX_HOUSEKEEPING_PENDING);
  archive(state, directory, pending.slice(0, overflow).map(item => ({ ...item, reason: 'queue_capacity_retained' })));
  return pending.slice(overflow);
}
export function compactHousekeeping(state, directory) {
  if (!state.housekeeping) return;
  if (!Array.isArray(state.housekeeping.pending) || state.housekeeping.pending.some(item => !valid(item))) throw new Error('Invalid housekeeping checkpoint.');
  state.housekeeping.pending = bounded(state, state.housekeeping.pending, directory);
}
function retire(state, directory, records) {
  archive(state, directory, records);
  const branches = new Set(records.map(item => item.branch));
  state.housekeeping.pending = state.housekeeping.pending.filter(item => !branches.has(item.branch));
}
function retireServerRecords(state, directory, candidates, response) {
  if (!Array.isArray(response.retired)) return;
  const records = candidates.flatMap(item => {
    const retired = response.retired.find(entry => entry.jobId === item.jobId && entry.fence === item.fence && ['execution_replaced', 'job_unavailable'].includes(entry.reason));
    return retired ? [{ ...item, reason: retired.reason }] : [];
  });
  retire(state, directory, records);
}
function branchAbsent(repo, branch, runGit) {
  try { runGit(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]); return false; }
  catch (error) { return error.status === 1; }
}

/** Acknowledged jobs only; the server confirms terminal task state on every
 * pass. The existing worker retains its exclusive lock throughout cleanup. */
export async function housekeepWorker({ state, persist, packet, lock, repo, directory, remote, runGit, signal, now = Date.now, cleanup = cleanupLocalWorktrees }) {
  if (signal?.aborted || !lock.isOwned() || !Array.isArray(state.housekeeping?.pending) || !state.housekeeping.pending.length) return { skipped: true };
  compactHousekeeping(state, directory);
  if (state.housekeeping.lastAttemptMs && now() - state.housekeeping.lastAttemptMs < 60000) return { skipped: true };
  const pending = state.housekeeping.pending.filter(valid);
  if (pending.length !== state.housekeeping.pending.length) throw new Error('Invalid housekeeping checkpoint; preserve worktrees for inspection.');
  // Rotate retained items so a long-lived blocker cannot starve later cleanup.
  const candidates = pending.slice(0, 10);
  state.housekeeping.pending = [...pending.slice(10), ...candidates];
  state.housekeeping.lastAttemptMs = now(); persist();
  assertRepositoryOrigin(repo, remote, runGit);
  const absent = candidates.filter(item => state.active?.branch !== item.branch && branchAbsent(repo, item.branch, runGit));
  retire(state, directory, absent.map(item => ({ ...item, reason: 'branch_absent_worktree_preserved' }))); persist();
  const present = candidates.filter(item => !absent.includes(item));
  if (!present.length) return { retired: absent.length, retentionArchive: state.housekeeping.retentionArchive };
  const response = await packet({ action: 'housekeeping', candidates: present.map(({ jobId, fence }) => ({ jobId, fence })) });
  if (response.stop) return { stop: true };
  if (signal?.aborted || !lock.isOwned()) return { skipped: true };
  if (!Array.isArray(response.eligible) || !response.repository || remote !== `${response.repository.owner}/${response.repository.repo}`.toLowerCase()) throw new Error('Housekeeping repository acknowledgement is invalid.');
  retireServerRecords(state, directory, present, response); persist();
  const approved = present.filter(item => state.housekeeping.pending.includes(item) && response.eligible.some(allowed => allowed.jobId === item.jobId && allowed.fence === item.fence));
  if (!approved.length) return { retained: candidates.length };
  const base = response.repository.base;
  if (typeof base !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(base)) throw new Error('Invalid housekeeping base.');
  runGit(repo, ['check-ref-format', `refs/heads/${base}`]);
  assertRepositoryOrigin(repo, remote, runGit);
  runGit(repo, ['fetch', 'origin']);
  if (signal?.aborted || !lock.isOwned()) return { skipped: true };
  // Fetch can take time. Recheck the same jobs and hub stop state before any
  // removal, never reinterpret stale local task status as server permission.
  const current = await packet({ action: 'housekeeping', candidates: approved.map(({ jobId, fence }) => ({ jobId, fence })) });
  if (current.stop) return { stop: true };
  if (signal?.aborted || !lock.isOwned() || JSON.stringify(current.repository) !== JSON.stringify(response.repository) || !Array.isArray(current.eligible)) return { skipped: true };
  assertRepositoryOrigin(repo, remote, runGit);
  retireServerRecords(state, directory, approved, current); persist();
  const eligibleBranches = approved.filter(item => state.housekeeping.pending.includes(item) && current.eligible.some(allowed => allowed.jobId === item.jobId && allowed.fence === item.fence)).map(item => item.branch);
  if (!eligibleBranches.length) return { retained: candidates.length };
  const report = cleanup({ repo, state: directory, base, remoteBase: true, apply: true, verifyGitHub: true, expectedRepository: remote, workerLock: lock, eligibleBranches, activeBranches: state.active?.branch ? [state.active.branch] : [] });
  const removed = new Set(report.branches.filter(item => item.state === 'deleted').map(item => item.branch));
  state.housekeeping.pending = state.housekeeping.pending.filter(item => !removed.has(item.branch));
  state.housekeeping.lastResult = { at: new Date(now()).toISOString(), removed: removed.size, retained: report.branches.filter(item => item.state !== 'deleted').length }; persist();
  return state.housekeeping.lastResult;
}

export function rememberHousekeeping(state, jobId, fence, options = {}) {
  const item = { jobId, fence, branch: `workforce/${jobId}-${fence}` };
  if (!valid(item)) throw new Error('Invalid housekeeping job identity.');
  state.housekeeping ??= { pending: [] };
  if (!Array.isArray(state.housekeeping.pending) || state.housekeeping.pending.some(item => !valid(item))) throw new Error('Invalid housekeeping checkpoint.');
  if (!state.housekeeping.pending.some(prior => prior.jobId === jobId && prior.fence === fence)) state.housekeeping.pending = bounded(state, [...state.housekeeping.pending, item], options.directory);
}
