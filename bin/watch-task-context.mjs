/** Recent watch confirmation is observational context, never permission to work. */
export function createWatchTaskContext(taskId, leaseVersion, now = () => performance.now()) {
  if (taskId !== undefined && (typeof taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(taskId)
    || ['__proto__', 'constructor', 'prototype'].includes(taskId)
    || !Number.isSafeInteger(leaseVersion) || leaseVersion < 0)) throw new Error('Task reporting requires a valid task ID and lease version.');
  let confirmedAt = null, currentTaskId, validForMs = 55_000;
  return {
    confirm(requestStartedAt, observed) {
      confirmedAt = null; currentTaskId = undefined; validForMs = 55_000;
      if (!Number.isFinite(requestStartedAt) || requestStartedAt > now()) return;
      if (observed === undefined) currentTaskId = taskId; // Older servers: explicit flags only.
      else if (observed && typeof observed.task_id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(observed.task_id)
        && !['__proto__', 'constructor', 'prototype'].includes(observed.task_id)
        && Number.isSafeInteger(observed.lease_version) && observed.lease_version >= 0
        && Number.isSafeInteger(observed.valid_for_ms) && observed.valid_for_ms > 0 && observed.valid_for_ms <= 55_000
        && (taskId === undefined || taskId === observed.task_id && leaseVersion === observed.lease_version)) {
        currentTaskId = observed.task_id; validForMs = observed.valid_for_ms;
      }
      if (currentTaskId) confirmedAt = requestStartedAt;
    },
    clear() { confirmedAt = null; },
    current() {
      const age = confirmedAt === null ? Infinity : now() - confirmedAt;
      // Bound context from request start, not the delayed long-poll response.
      return age >= 0 && age < validForMs ? currentTaskId : undefined;
    },
  };
}
