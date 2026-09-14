import { advanceSessionUsageWindow } from './session-usage-window.mjs';

/** Translate verified native counters into observational activity, never billing.
 * The first read establishes a baseline: an old log is not evidence of new work.
 * The caller owns the existing durable activity reporter and its lifecycle. */
export function createSessionActivityRecorder({ client, sessionId, connectionScope, reporter }) {
  if (typeof reporter?.record !== 'function') throw new Error('Native activity requires a durable activity reporter.');
  const identity = { client, sessionId, connectionScope };
  advanceSessionUsageWindow(null, null, identity);
  let state = null;
  return {
    record(snapshot) {
      const next = advanceSessionUsageWindow(state, snapshot, identity);
      if (!next.reports.length) { state = next.state; return false; }
      const totals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      for (const row of next.state.latest) {
        totals.inputTokens += row.input_tokens + (row.token_semantics === 'anthropic' ? row.cache_read_tokens + row.cache_write_tokens : 0);
        totals.outputTokens += row.output_tokens;
        totals.cachedInputTokens += row.cache_read_tokens;
      }
      if (Object.values(totals).some(value => !Number.isSafeInteger(value)) || !Number.isSafeInteger(totals.inputTokens + totals.outputTokens)) throw new Error('Native activity totals exceed the safe integer range.');
      // Whole-session totals remain labelled as such; never attribute historical
      // tokens to whichever task happens to be active at the observation time.
      if (reporter.record({ kind: 'usage_reported', usageScope: 'session', ...totals }, { runId: sessionId }) !== true) return false;
      state = next.state;
      return true;
    },
  };
}
