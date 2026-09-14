import { createHash } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createActivityReporter } from './activity.mjs';
import { createSessionFileObserver } from './session-observation-file.mjs';
import { createSessionActivityRecorder } from './session-activity.mjs';

/** Passive native observations, never billable usage or permission to run a model. */
export async function startWatchObservations(options) {
  const { client, sessionId, sessionFile, cwd, server, token, directory, signal } = options;
  if (!['codex', 'claude-code'].includes(client) || !sessionId || !sessionFile || !cwd || !isAbsolute(sessionFile) || !isAbsolute(cwd) || !signal) {
    throw new Error('watch --report requires --client codex|claude-code, --session <UUID>, --session-file <absolute path> and --cwd <absolute repository path>.');
  }
  const observe = createSessionFileObserver(sessionFile, { client, sessionId, cwd, signal });
  const baseline = await observe();
  let lastTurn = JSON.stringify(observe.turnState());
  signal.throwIfAborted();
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener('abort', stop, { once: true });
  const scope = createHash('sha256').update(`${new URL(server).origin}:${token}:${client}:${sessionId}`).digest('hex');
  let reporter;
  const status = (state, reason) => options.onStatus?.({ state, ...(reason ? { reason } : {}) });
  const fail = error => {
    if (controller.signal.aborted) return;
    if (error.permanent || error.retryable !== true) {
      status('paused', [401, 403].includes(error.status) ? 'authentication_required' : 'observation_error');
      controller.abort();
      if ([401, 403].includes(error.status)) options.onAuthenticationFailure?.();
    } else status('retrying', 'delivery_unavailable');
  };
  try {
    reporter = createActivityReporter({ server, token, statePath: join(directory, `observations-${scope.slice(0, 20)}.json`), signal: controller.signal,
      onError: error => fail(error.permanent ? error : Object.assign(error, { retryable: true })) });
    const recorder = createSessionActivityRecorder({ client, sessionId, connectionScope: scope, reporter });
    recorder.record(baseline);
    status('waiting');
    const run = (async () => {
      while (!controller.signal.aborted) {
        await delay(30_000, undefined, { signal: controller.signal });
        const snapshot = await observe();
        controller.signal.throwIfAborted();
        const accepted = recorder.record(snapshot);
        // Publish the latest explicit turn state after usage so a completed
        // turn is not made to look active by its final token observation.
        const turn = observe.turnState();
        const turnKey = JSON.stringify(turn);
        // The native watch is one session-scoped activity stream. Keep its
        // lifecycle and counters together: the hub selects usage by runId.
        // The turn identity above still detects distinct turns of the same kind.
        const taskId = options.currentTask?.();
        if (turn && turnKey !== lastTurn && reporter.record({ kind: turn.kind }, { runId: sessionId, ...(taskId ? { taskId } : {}) })) lastTurn = turnKey;
        status(accepted ? 'observed' : 'waiting');
      }
    })().catch(error => { if (!controller.signal.aborted) fail(error); });
    return { async close() {
      stop(); signal.removeEventListener('abort', stop);
      reporter.stop(); await run; await reporter.close();
    } };
  } catch (error) {
    signal.removeEventListener('abort', stop); reporter?.stop();
    throw error;
  }
}
