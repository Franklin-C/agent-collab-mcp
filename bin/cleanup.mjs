import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { acquireWorkerLock } from './worker-lock.mjs';
import { githubRepository } from './repository.mjs';

const inside = (root, target) => { const rel = relative(root, target); return rel !== '' && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel); };
function command(file, args, cwd) { return execFileSync(file, args, { cwd, encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 }).trim(); }

/** Only remove clean, inactive managed worktrees. Never uses recursive filesystem
 * deletion or Git --force. Unmerged work is reported and preserved regardless of age. */
export function cleanupLocalWorktrees(options) {
  if (!options.repo || !options.state) throw new Error('Cleanup requires --repo and the managed worker --state directory.');
  const repo = realpathSync(options.repo), state = realpathSync(options.state), worktreesRoot = join(state, 'worktrees');
  const git = args => command('git', args, repo);
  const expectedRepository = options.expectedRepository ?? (options.verifyGitHub ? githubRepository(git(['remote', 'get-url', 'origin'])) : null);
  const originMatches = () => { try { return !expectedRepository || githubRepository(git(['remote', 'get-url', 'origin'])) === expectedRepository; } catch { return false; } };
  const base = options.base ?? 'main';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(base)) throw new Error('Invalid cleanup base branch.');
  git(['check-ref-format', `refs/heads/${base}`]);
  const baseRef = options.remoteBase ? `refs/remotes/origin/${base}` : `refs/heads/${base}`;
  const baseSha = git(['rev-parse', '--verify', `${baseRef}^{commit}`]);
  const lock = join(state, 'worker.lock');
  const borrowedLock = options.workerLock;
  if (borrowedLock && (!borrowedLock.ownsDirectory?.(state) || !borrowedLock.isOwned?.() || !Array.isArray(options.eligibleBranches))) throw new Error('Automatic cleanup requires this worker lock and an explicit eligible-branch list.');
  let ownedLock = borrowedLock ?? null;
  const locked = () => ownedLock ? !ownedLock.isOwned() : !!options.apply || existsSync(lock) || existsSync(join(state, 'worker.lock.guard'));
  const commonDir = realpathSync(resolve(repo, git(['rev-parse', '--git-common-dir'])));
  const historyRewritten = () => {
    // Local replacement objects and legacy grafts can invent ancestry that was
    // never merged or published. Preserve all work until that ambiguity is gone.
    const replacementBase = process.env.GIT_REPLACE_REF_BASE || 'refs/replace/';
    if (!replacementBase.startsWith('refs/') || existsSync(join(commonDir, 'info', 'grafts')) || process.env.GIT_GRAFT_FILE && existsSync(resolve(repo, process.env.GIT_GRAFT_FILE))) return true;
    return Boolean(git(['for-each-ref', '--format=%(refname)', 'refs/replace/', replacementBase]));
  };
  const rows = git(['worktree', 'list', '--porcelain', '-z']).split('\0\0').filter(Boolean).map(record => Object.fromEntries(record.split('\0').filter(Boolean).map(line => { const space = line.indexOf(' '); return space < 0 ? [line, true] : [line.slice(0, space), line.slice(space + 1)]; })));
  const branches = git(['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads/workforce/']).split('\n').filter(Boolean).map(line => { const [branch, sha] = line.split('\t'); return { branch, sha }; }).filter(entry => !options.eligibleBranches || options.eligibleBranches.includes(entry.branch));
  function ancestor(sha) { try { git(['merge-base', '--is-ancestor', sha, baseSha]); return true; } catch { return false; } }
  const mergedProof = options.verifyGitHub ? sha => {
    if (!originMatches()) return false;
    const remote = git(['remote', 'get-url', 'origin']);
    const match = remote.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([a-zA-Z0-9_.-]+\/([a-zA-Z0-9_.-]+?))(?:\.git)?$/);
    if (!match) return false;
    const repository = match[1];
    const pages = JSON.parse(command('gh', ['api', '--paginate', '--slurp', `repos/${repository}/commits/${sha}/pulls?per_page=100`], repo));
    return originMatches() && pages.flat().some(pr => pr.merged_at && pr.head?.sha === sha && pr.head?.repo?.full_name?.toLowerCase() === repository.toLowerCase() && pr.base?.ref === base && pr.merge_commit_sha && ancestor(pr.merge_commit_sha));
  } : () => false;
  function inspect(entry) {
    const reasons = [], tree = rows.find(row => row.branch === `refs/heads/${entry.branch}`);
    if (locked()) reasons.push('worker_lock_present');
    if (!originMatches()) reasons.push('repository_origin_changed');
    if (historyRewritten()) reasons.push('repository_history_rewritten');
    if (options.eligibleBranches && !options.eligibleBranches.includes(entry.branch)) reasons.push('job_not_confirmed_inactive');
    if (options.activeBranches?.includes(entry.branch)) reasons.push('active_worker_branch');
    if (entry.branch === base) reasons.push('base_branch');
    if (git(['rev-parse', '--verify', `refs/heads/${entry.branch}`]) !== entry.sha) reasons.push('branch_advanced');
    if (!tree) reasons.push('not_registered_managed_worktree');
    if (tree) {
      if (tree.locked || tree.prunable || !existsSync(tree.worktree)) reasons.push('worktree_unavailable_or_locked');
      else {
        const path = realpathSync(tree.worktree);
        if (!inside(worktreesRoot, path) || path === repo || !inside(state, path)) reasons.push('outside_managed_worktrees');
        if (realpathSync(resolve(path, command('git', ['rev-parse', '--git-common-dir'], path))) !== commonDir) reasons.push('different_repository');
        // Both status and non-force worktree removal trust these index flags.
        // Inspect without clearing them: skipped or assumed-clean files can
        // contain edits that Git would otherwise silently delete with the tree.
        if (command('git', ['ls-files', '-v', '-z'], path).split('\0').some(record => /^[a-zS] /.test(record))) reasons.push('index_flags_hide_worktree_changes');
        if (command('git', ['status', '--porcelain', '--untracked-files=all', '--ignored'], path)) reasons.push('uncommitted_untracked_or_ignored_files');
      }
    }
    if (!ancestor(entry.sha)) {
      try { if (!mergedProof(entry.sha)) reasons.push('merge_not_verified'); }
      catch { reasons.push('merge_verification_failed'); }
    }
    if (!originMatches() && !reasons.includes('repository_origin_changed')) reasons.push('repository_origin_changed');
    return { ...entry, path: tree?.worktree ?? null, state: reasons.length ? 'retained' : 'eligible', reasons };
  }
  const audit = result => appendFileSync(join(state, 'cleanup-audit.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), base, baseSha, ...result })}\n`, { mode: 0o600 });
  const report = [];
  if (options.apply && !borrowedLock) { try { ownedLock = acquireWorkerLock(state, `cleanup:${state}`); } catch { /* Existing worker or cleanup owns this directory. */ } }
  try {
  for (const branch of branches) {
    let result;
    try {
      result = inspect(branch);
      if (options.apply && result.state === 'eligible') {
        audit({ ...result, state: 'dispatch' });
        result = inspect(branch);
        if (result.state === 'eligible') {
          // Validate resolved paths immediately before Git removes a worktree.
          if (result.path) {
            const path = realpathSync(result.path);
            if (!inside(state, path) || !inside(worktreesRoot, path) || path === repo || locked() || !originMatches() || historyRewritten()) throw new Error('Cleanup scope changed.');
            git(['worktree', 'remove', path]);
          }
          // Atomic expected-old-SHA deletion rejects a concurrent branch update.
          if (!originMatches()) throw new Error('Cleanup repository changed.');
          git(['update-ref', '-d', `refs/heads/${branch.branch}`, branch.sha]);
          result = { ...result, state: 'deleted' };
        }
        audit(result);
      }
    } catch { result = { ...branch, state: 'deferred', reasons: ['cleanup_failed_branch_preserved_or_recheck_required'] }; }
    report.push(result);
  }
  } finally { if (!borrowedLock) ownedLock?.release(); }
  return { dryRun: !options.apply, base, baseSha, scope: 'Local workforce/* branches and worktrees inside the selected worker state directory only. Fetch current base before cleanup; remote branches are unchanged.', branches: report };
}
