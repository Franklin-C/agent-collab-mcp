import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupLocalWorktrees } from '../bin/cleanup.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ehgi-cleanup-')), repo = join(root, 'repo'), state = join(root, 'worker');
  mkdirSync(repo); mkdirSync(join(state, 'worktrees'), { recursive: true });
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git(['init', '-b', 'main']); git(['config', 'user.email', 'test@example.test']); git(['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'readme'), 'base'); git(['add', '.']); git(['commit', '-m', 'base']);
  const tree = join(state, 'worktrees', 'task-1'); git(['worktree', 'add', '-b', 'workforce/task-1', tree]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { repo, state, tree, git };
}
test('dry run reports eligible branch without changing files or references', t => {
  const f = fixture(t), result = cleanupLocalWorktrees(f);
  assert.equal(result.branches[0].state, 'eligible'); assert.equal(result.dryRun, true);
  assert.ok(existsSync(f.tree)); assert.ok(f.git(['rev-parse', 'workforce/task-1'])); assert.equal(existsSync(join(f.state, 'cleanup-audit.jsonl')), false);
});
test('apply removes a clean merged managed worktree and branch, keeping main and audit', t => {
  const f = fixture(t), result = cleanupLocalWorktrees({ ...f, apply: true });
  assert.equal(result.branches[0].state, 'deleted'); assert.equal(existsSync(f.tree), false);
  assert.equal(f.git(['branch', '--format=%(refname:short)']), 'main'); assert.ok(existsSync(join(f.state, 'cleanup-audit.jsonl')));
});
test('preserves untracked and ignored files', t => {
  const f = fixture(t); writeFileSync(join(f.tree, '.env'), 'local-secret');
  assert.ok(cleanupLocalWorktrees({ ...f, apply: true }).branches[0].reasons.includes('uncommitted_untracked_or_ignored_files')); assert.ok(existsSync(f.tree));
});

for (const flags of [['--assume-unchanged'], ['--skip-worktree'], ['--assume-unchanged', '--skip-worktree']]) test(`preserves edits hidden by index flags ${flags.join(' ')}`, t => {
  const f = fixture(t);
  const treeGit = args => execFileSync('git', args, { cwd: f.tree, encoding: 'utf8', windowsHide: true }).trim();
  for (const flag of flags) treeGit(['update-index', flag, 'readme']);
  writeFileSync(join(f.tree, 'readme'), 'hidden uncommitted work');
  assert.equal(treeGit(['status', '--porcelain', '--untracked-files=all', '--ignored']), '', 'Git status cannot see these edits');
  const flagsBefore = treeGit(['ls-files', '-v', '-z']);
  for (const apply of [false, true]) {
    const result = cleanupLocalWorktrees({ ...f, apply });
    assert.equal(result.branches[0].state, 'retained');
    assert.ok(result.branches[0].reasons.includes('index_flags_hide_worktree_changes'));
    assert.equal(readFileSync(join(f.tree, 'readme'), 'utf8'), 'hidden uncommitted work');
    assert.equal(treeGit(['ls-files', '-v', '-z']), flagsBefore, 'inspection must not change index flags');
    assert.ok(f.git(['rev-parse', 'workforce/task-1']));
  }
});
test('worker lock prevents cleanup even for fully merged work', t => {
  const f = fixture(t); writeFileSync(join(f.state, 'worker.lock'), '123');
  assert.ok(cleanupLocalWorktrees({ ...f, apply: true }).branches[0].reasons.includes('worker_lock_present')); assert.ok(existsSync(f.tree));
});
test('preserves unpublished commits with no age-based exceptions', t => {
  const f = fixture(t); writeFileSync(join(f.tree, 'new'), 'unpublished');
  execFileSync('git', ['add', '.'], { cwd: f.tree, windowsHide: true }); execFileSync('git', ['commit', '-m', 'unpublished'], { cwd: f.tree, windowsHide: true });
  assert.ok(cleanupLocalWorktrees({ ...f, apply: true }).branches[0].reasons.includes('merge_not_verified')); assert.ok(existsSync(f.tree));
});

for (const rewrite of ['replace', 'custom-replace', 'graft']) test(`retains unmerged work when local ${rewrite} history makes it appear merged`, t => {
  const f = fixture(t);
  const treeGit = args => execFileSync('git', args, { cwd: f.tree, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  writeFileSync(join(f.tree, 'feature.txt'), 'unmerged feature'); treeGit(['add', '.']); treeGit(['commit', '-m', 'unmerged feature']);
  const head = treeGit(['rev-parse', 'HEAD']);
  writeFileSync(join(f.repo, 'main.txt'), 'independent main work'); f.git(['add', '.']); f.git(['commit', '-m', 'main work']);
  const base = f.git(['rev-parse', 'HEAD']);
  assert.throws(() => f.git(['merge-base', '--is-ancestor', head, base]), error => error.status === 1);
  if (rewrite === 'custom-replace') {
    const original = process.env.GIT_REPLACE_REF_BASE;
    process.env.GIT_REPLACE_REF_BASE = 'refs/test-replacements/';
    t.after(() => { if (original === undefined) delete process.env.GIT_REPLACE_REF_BASE; else process.env.GIT_REPLACE_REF_BASE = original; });
  }
  if (rewrite !== 'graft') {
    const replacement = f.git(['commit-tree', `${base}^{tree}`, '-p', head, '-m', 'virtual ancestry']);
    f.git(['replace', base, replacement]);
  } else writeFileSync(join(f.repo, '.git', 'info', 'grafts'), `${base} ${head}\n`);
  assert.equal(f.git(['merge-base', '--is-ancestor', head, base]), '', 'local rewriting hides the true ancestry');
  for (const apply of [false, true]) {
    const result = cleanupLocalWorktrees({ ...f, apply });
    assert.equal(result.branches[0].state, 'retained');
    assert.ok(result.branches[0].reasons.includes('repository_history_rewritten'));
    assert.equal(readFileSync(join(f.tree, 'feature.txt'), 'utf8'), 'unmerged feature');
    assert.equal(f.git(['rev-parse', 'refs/heads/workforce/task-1']), head);
  }
});
test('never removes a worktree outside the explicitly selected worker directory', t => {
  const f = fixture(t), other = join(f.repo, 'other-worker'); mkdirSync(join(other, 'worktrees'), { recursive: true });
  assert.ok(cleanupLocalWorktrees({ repo: f.repo, state: other, apply: true }).branches[0].reasons.includes('outside_managed_worktrees')); assert.ok(existsSync(f.tree));
});
