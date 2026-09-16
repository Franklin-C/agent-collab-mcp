import { setTimeout as delay } from 'node:timers/promises';

/** Passive reporting; its caller supplies accounting authority and cancellation. */
export function createSessionReportCycle({ observe, outbox, deliver, canReport, signal, onStatus = () => {} }) {
  if (typeof observe !== 'function' || typeof deliver !== 'function' || typeof canReport !== 'function'
    || typeof outbox?.record !== 'function' || typeof outbox?.flush !== 'function') throw new Error('Reporting requires an observer, durable outbox and accounting authority check.');
  let pending = null, running = null, paused = false;
  const status = (state, reason) => { try { onStatus({ state, ...(reason ? { reason } : {}) }); } catch { /* Status presentation cannot change accounting. */ } };
  const permitted = async () => {
    if (signal?.aborted) return false;
    return await canReport() === true && !signal?.aborted;
  };
  const denied = (sent = false) => {
    status(signal?.aborted ? 'stopped' : 'paused', signal?.aborted ? 'stop_requested' : 'accounting_authority_required');
    return { sent };
  };
  const cycle = {
    tick() {
      if (pending) return pending;
      if (paused) return Promise.resolve({ sent: false });
      pending = (async () => {
        let sent = false;
        try {
          if (!await permitted()) return denied();
          status('observing');
          const snapshot = await observe();
          // Stop or revocation during a slow initial log scan must prevent any
          // baseline change or subsequent upload under obsolete authority.
          if (!await permitted()) return denied();
          outbox.record(snapshot);
          await outbox.flush(async report => {
            if (!await permitted()) throw Object.assign(new Error('Reporting authority changed.'), { denied: true });
            status('reporting');
            const result = await deliver(report, signal);
            sent ||= result?.ok === true;
            return result;
          });
          // No new metadata is a waiting observation, never evidence of logout.
          status(signal?.aborted ? 'stopped' : 'waiting', signal?.aborted ? 'stop_requested' : undefined);
          return { sent };
        } catch (error) {
          if (signal?.aborted || error?.denied) return denied(sent);
          if (error?.retryable === true) { status('retrying', 'delivery_unavailable'); return { sent }; }
          paused = true;
          status('paused', [401, 403].includes(error?.status) ? 'authentication_required' : 'reporting_error');
          return { sent };
        }
      })().finally(() => { pending = null; });
      return pending;
    },
    run({ intervalMs = 30_000, wait = (ms, signal) => delay(ms, undefined, { signal }) } = {}) {
      if (!signal || typeof signal.addEventListener !== 'function') throw new Error('Scheduled reporting requires a cancellation signal.');
      if (!Number.isSafeInteger(intervalMs) || intervalMs < 30_000 || intervalMs > 300_000 || typeof wait !== 'function') throw new Error('Reporting interval must be between 30 and 300 seconds.');
      if (running) return running;
      running = (async () => {
        while (!signal.aborted && !paused) {
          await cycle.tick();
          if (signal.aborted || paused) break;
          // Wait after completion, so slow reads/uploads cannot create a queue
          // of overlapping polls. No timer or model runs after a permanent error.
          try { await wait(intervalMs, signal); }
          catch (error) { if (!signal.aborted) throw error; }
        }
        if (signal.aborted) status('stopped', 'stop_requested');
        return { reason: signal.aborted ? 'stopped' : 'paused' };
      })().finally(() => { running = null; });
      return running;
    },
  };
  return cycle;
}
