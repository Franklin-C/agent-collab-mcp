// Older hubs use a fixed 90-second lease. A newer hub can advertise a shorter
// window; a longer advertised lease is still capped conservatively here.
const LEGACY_LEASE_MS = 90_000;
const TERMINATION_MARGIN_MS = 10_000;

/** A late response never revives expired authority. Use monotonic request-start
 * time, not response receipt or wall-clock time, to include network delay. */
export function createAuthorityGuard({ onExpire, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let deadline = null, timer, failure, closed = false;
  const expire = (message = 'Execution lease could not be renewed in time. Worker stopped before its authority expired.') => {
    if (!failure) {
      failure = Object.assign(new Error(message), { code: 'WORKER_AUTHORITY_EXPIRED', retryable: false });
      clearTimer(timer); onExpire(failure);
    }
    return failure;
  };
  const check = () => {
    if (failure) throw failure;
    if (deadline !== null && now() >= deadline) throw expire();
  };
  const arm = () => {
    clearTimer(timer);
    timer = setTimer(() => {
      if (closed || failure) return;
      if (now() >= deadline) expire(); else arm();
    }, Math.max(0, deadline - now()));
    timer?.unref?.();
  };
  return {
    check,
    accept(requestStartedAt, leaseDurationMs = LEGACY_LEASE_MS) {
      if (closed) throw new Error('Execution authority guard is closed.');
      check();
      if (!Number.isFinite(requestStartedAt) || requestStartedAt > now() || !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) throw expire('The hub returned an invalid execution lease.');
      const next = requestStartedAt + Math.min(leaseDurationMs, LEGACY_LEASE_MS) - TERMINATION_MARGIN_MS;
      if (now() >= next) throw expire();
      deadline = next; arm();
    },
    close() { closed = true; clearTimer(timer); },
  };
}
