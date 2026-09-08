export function githubRepository(remote) {
  const match = remote.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:)([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/);
  if (!match) throw new Error('Worker requires an explicitly configured GitHub origin over HTTPS or SSH.');
  return `${match[1]}/${match[2]}`.toLowerCase();
}

export function assertRepositoryOrigin(repo, expected, runGit) {
  let actual;
  try { actual = githubRepository(runGit(repo, ['remote', 'get-url', 'origin'])); } catch { /* Missing or unsupported origins also stop execution. */ }
  if (actual !== expected) throw Object.assign(new Error('The local origin changed from the enrolled repository. Execution and cleanup are paused.'), { code: 'REPOSITORY_CHANGED', retryable: false });
}
