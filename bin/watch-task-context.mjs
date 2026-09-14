/** Recent watch confirmation is observational context, never permission to work. */
export function createWatchTaskContext(taskId, leaseVersion, now = () => performance.now()) {
  if (taskId !== undefined && (typeof taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(taskId)
    || ['__proto__', 'constructor', 'prototype'].includes(taskId)
    || !Number.isSafeInteger(leaseVersion) || leaseVersion < 0)) throw new Error('Task reporting requires a valid task ID and lease version.');
  let confirmedAt = null;
  return {
    confirm(requestStartedAt) {
      confirmedAt = taskId !== undefined && Number.isFinite(requestStartedAt) && requestStartedAt <= now() ? requestStartedAt : null;
    },
    clear() { confirmedAt = null; },
    current() {
      const age = confirmedAt === null ? Infinity : now() - confirmedAt;
      // Bound context from request start, not the delayed long-poll response.
      return age >= 0 && age < 55_000 ? taskId : undefined;
    },
  };
}
