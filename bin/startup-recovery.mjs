const TERMINAL_STATUS = new Set([400, 401, 403, 404, 409, 422]);
export function canRetryStartup(error) {
  return error?.retryable === true && !error.requiresApproval && !error.requiresAuthentication && !TERMINAL_STATUS.has(error.status) && error.code !== 'WORKER_LOCKED';
}

function waitForRetry(ms, signal) {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
    if (signal?.aborted) done();
  });
}

/** Retry only transport exits explicitly classified by the worker. A normal
 * return includes hub Stop/pause and is final. This loop never invokes a model
 * itself; each worker restart reauthenticates and checks the hub before work. */
export async function runWithStartupRecovery(run, options = {}) {
  const delays = options.delays ?? [1000, 4000, 15000];
  if (!Array.isArray(delays) || delays.length > 3 || delays.some(delay => !Number.isInteger(delay) || delay < 0 || delay > 30000)) throw new Error('Startup recovery allows at most three bounded transport retries.');
  const status = options.status ?? (() => {}), wait = options.wait ?? waitForRetry;
  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) { status('stopped', null); return { stopped: true }; }
    try {
      status('starting', null);
      const result = await run();
      status('stopped', null); return result;
    } catch (error) {
      if (options.signal?.aborted) { status('stopped', null); return { stopped: true }; }
      if (!canRetryStartup(error) || attempt >= delays.length) {
        status('needs_attention', 'Startup stopped. Check credentials, permissions, locks or the network before restarting.');
        throw error;
      }
      status('retrying_connection', `Transport retry ${attempt + 1} of ${delays.length}`);
      await wait(delays[attempt], options.signal);
    }
  }
}
