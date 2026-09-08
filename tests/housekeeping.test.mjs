import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../bin/worker.mjs';
import { acquireWorkerLock } from '../bin/worker-lock.mjs';
import { compactHousekeeping, housekeepWorker, MAX_HOUSEKEEPING_PENDING, rememberHousekeeping } from '../bin/housekeeping.mjs';
import { cleanupLocalWorktrees } from '../bin/cleanup.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ehgi-housekeeping-')), repo = join(root, 'repo'), directory = join(root, 'state');
  mkdirSync(repo); mkdirSync(join(directory, 'worktrees'), { recursive: true });
  git(repo, ['init', '-b', 'main']); git(repo, ['config', 'user.email', 'test@example.test']); git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['remote', 'add', 'origin', 'https://github.com/fixture/repo.git']);
  writeFileSync(join(repo, 'readme'), 'base'); writeFileSync(join(repo, '.gitignore'), '.env\n'); git(repo, ['add', '.']); git(repo, ['commit', '-m', 'base']);
  git(repo, ['update-ref', 'refs/remotes/origin/main', git(repo, ['rev-parse', 'HEAD']).trim()]);
  const tree = join(directory, 'worktrees', 'job-1'); git(repo, ['worktree', 'add', '-b', 'workforce/job-1', tree]);
  const state = {}, lock = acquireWorkerLock(directory, 'fixture'); rememberHousekeeping(state, 'job', 1);
  const response = { stop: false, eligible: [{ jobId: 'job', fence: 1 }], repository: { owner: 'fixture', repo: 'repo', base: 'main' } };
  const calls = [];
  const options = { state, directory, repo, lock, remote: 'fixture/repo', now: () => 1000000, persist: () => {}, cleanup: args => cleanupLocalWorktrees({ ...args, verifyGitHub: false }), runGit: (cwd, args) => args[0] === 'fetch' ? calls.push('fetch') : git(cwd, args), packet: async () => { calls.push('confirm'); return response; } };
  t.after(() => { lock.release(); rmSync(root, { recursive: true, force: true }); });
  return { tree, state, lock, options, calls, response, directory, repo };
}

test('automatic cleanup removes an acknowledged inactive worktree while retaining the worker lock and audit', async t => {
  const f = fixture(t), result = await housekeepWorker(f.options);
  assert.deepEqual(f.calls, ['confirm', 'fetch', 'confirm']);
  assert.equal(result.removed, 1); assert.equal(existsSync(f.tree), false); assert.equal(f.lock.isOwned(), true);
  assert.deepEqual(f.state.housekeeping.pending, []);
  assert.match(readFileSync(join(f.directory, 'cleanup-audit.jsonl'), 'utf8'), /"state":"deleted"/);
});

for (const kind of ['untracked', 'ignored', 'tracked', 'unpublished', 'active', 'assume-unchanged', 'skip-worktree']) test(`automatic cleanup preserves ${kind} work`, async t => {
  const f = fixture(t);
  if (kind === 'untracked') writeFileSync(join(f.tree, 'untracked.txt'), 'retain');
  if (kind === 'ignored') writeFileSync(join(f.tree, '.env'), 'retain');
  if (kind === 'tracked') writeFileSync(join(f.tree, 'readme'), 'changed');
  if (kind === 'assume-unchanged' || kind === 'skip-worktree') {
    git(f.tree, ['update-index', `--${kind}`, 'readme']);
    writeFileSync(join(f.tree, 'readme'), 'hidden work');
    assert.equal(git(f.tree, ['status', '--porcelain']).trim(), '');
  }
  if (kind === 'unpublished') { writeFileSync(join(f.tree, 'readme'), 'unpublished'); git(f.tree, ['add', '.']); git(f.tree, ['commit', '-m', 'unpublished']); }
  if (kind === 'active') f.state.active = { branch: 'workforce/job-1' };
  // Missing provider proof in the unpublished case fails closed, without any
  // provider call or accepting age as evidence that the branch was merged.
  const result = await housekeepWorker(f.options);
  assert.equal(result.removed, 0); assert.equal(existsSync(f.tree), true); assert.equal(f.lock.isOwned(), true);
  assert.equal(f.state.housekeeping.pending.length, 1);
});

test('unacknowledged runs, denied eligibility and hub Stop never dispatch filesystem cleanup', async t => {
  for (const mode of ['unacknowledged', 'ineligible', 'stop', 'stop-after-fetch', 'reopened-after-fetch']) {
    const f = fixture(t); let requests = 0;
    if (mode === 'unacknowledged') f.state.housekeeping.pending = [];
    const result = await housekeepWorker({ ...f.options, cleanup: () => assert.fail('cleanup must not run'), packet: async () => {
      requests++;
      if (mode === 'stop' || mode === 'stop-after-fetch' && requests === 2) return { stop: true };
      return { ...f.response, eligible: mode === 'ineligible' || mode === 'reopened-after-fetch' && requests === 2 ? [] : f.response.eligible };
    } });
    if (mode === 'unacknowledged') assert.equal(requests, 0);
    if (mode.startsWith('stop')) assert.equal(result.stop, true);
    assert.equal(existsSync(f.tree), true);
  }
});

test('cleanup is throttled and candidate batches rotate without model calls', async t => {
  const f = fixture(t), batches = [];
  for (let index = 2; index <= 12; index++) {
    rememberHousekeeping(f.state, 'job', index);
    git(f.repo, ['update-ref', `refs/heads/workforce/job-${index}`, 'HEAD']);
  }
  const options = { ...f.options, packet: async packet => { batches.push(packet.candidates); return { ...f.response, eligible: [] }; } };
  await housekeepWorker(options); await housekeepWorker(options);
  assert.equal(batches.length, 1); assert.equal(batches[0].length, 10);
  await housekeepWorker({ ...options, now: () => 1060000 });
  assert.equal(batches[1][0].fence, 11);
});

test('changed lock ownership prevents automatic cleanup', async t => {
  const f = fixture(t); writeFileSync(join(f.directory, 'worker.lock'), 'replacement');
  assert.deepEqual(await housekeepWorker({ ...f.options, packet: async () => assert.fail('no request without lock') }), { skipped: true });
  assert.equal(existsSync(f.tree), true);
});

test('manually removed branches retire their receipt without repeated server reads or worktree deletion', async t => {
  const f = fixture(t); git(f.repo, ['update-ref', '-d', 'refs/heads/workforce/job-1']);
  const result = await housekeepWorker({ ...f.options, packet: async () => assert.fail('missing branch needs no server request') });
  assert.equal(result.retired, 1); assert.deepEqual(f.state.housekeeping.pending, []);
  assert.equal(existsSync(f.tree), true, 'an orphaned worktree is retained for inspection');
  assert.match(readFileSync(join(f.directory, 'housekeeping-retained.jsonl'), 'utf8'), /branch_absent_worktree_preserved/);
  assert.deepEqual(await housekeepWorker(f.options), { skipped: true });
});

test('server-confirmed replaced fences archive metadata and preserve the branch and worktree', async t => {
  const f = fixture(t);
  await housekeepWorker({ ...f.options, packet: async () => ({ ...f.response, eligible: [], retired: [{ jobId: 'job', fence: 1, reason: 'execution_replaced' }] }) });
  assert.deepEqual(f.state.housekeeping.pending, []); assert.equal(existsSync(f.tree), true);
  assert(git(f.repo, ['rev-parse', 'refs/heads/workforce/job-1']).trim());
  assert.equal(f.state.housekeeping.archivedCount, 1);
  assert.match(readFileSync(join(f.directory, f.state.housekeeping.retentionArchive), 'utf8'), /execution_replaced/);
});

test('actionable receipts stay bounded and overflow remains visible in a separate retention archive', t => {
  const f = fixture(t);
  for (let index = 2; index <= MAX_HOUSEKEEPING_PENDING + 5; index++) rememberHousekeeping(f.state, 'job', index, { directory: f.directory });
  assert.equal(f.state.housekeeping.pending.length, MAX_HOUSEKEEPING_PENDING);
  assert.equal(f.state.housekeeping.archivedCount, 5); assert.equal(existsSync(f.tree), true);
  const archive = readFileSync(join(f.directory, 'housekeeping-retained.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(archive.length, 5); assert(archive.every(item => item.reason === 'queue_capacity_retained' && item.files === 'unchanged'));
  const legacy = { housekeeping: { pending: Array.from({ length: 125 }, (_, index) => ({ jobId: 'legacy', fence: index + 1, branch: `workforce/legacy-${index + 1}` })) } };
  compactHousekeeping(legacy, f.directory);
  assert.equal(legacy.housekeeping.pending.length, MAX_HOUSEKEEPING_PENDING); assert.equal(legacy.housekeeping.archivedCount, 25);
});

for (const moment of ['before-fetch', 'first-acknowledgement', 'second-acknowledgement', 'final-inspection']) test(`actual origin changes at ${moment} cannot use another repository's ancestor proof`, async t => {
  const f = fixture(t);
  writeFileSync(join(f.tree, 'readme'), 'unmerged change'); git(f.tree, ['add', '.']); git(f.tree, ['commit', '-m', 'unmerged work']);
  const candidate = git(f.tree, ['rev-parse', 'HEAD']).trim();
  const changeOrigin = () => {
    git(f.repo, ['remote', 'set-url', 'origin', 'https://github.com/unrelated/repository.git']);
    git(f.repo, ['update-ref', 'refs/remotes/origin/main', candidate]);
  };
  let acknowledgements = 0;
  if (moment === 'before-fetch') changeOrigin();
  const options = { ...f.options, packet: async () => {
    acknowledgements++;
    if (moment === 'first-acknowledgement' && acknowledgements === 1 || moment === 'second-acknowledgement' && acknowledgements === 2) changeOrigin();
    return f.response;
  }, cleanup: args => { assert.equal(args.expectedRepository, 'fixture/repo'); if (moment === 'final-inspection') changeOrigin(); return cleanupLocalWorktrees({ ...args, verifyGitHub: false }); } };
  if (moment === 'final-inspection') assert.equal((await housekeepWorker(options)).removed, 0);
  else await assert.rejects(housekeepWorker(options), /origin changed/);
  assert.equal(existsSync(f.tree), true);
  assert.equal(git(f.repo, ['rev-parse', 'refs/heads/workforce/job-1']).trim(), candidate);
  if (moment === 'before-fetch' || moment === 'first-acknowledgement') assert(!f.calls.includes('fetch'));
});
