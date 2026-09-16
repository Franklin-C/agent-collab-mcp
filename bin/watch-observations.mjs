import { createHash } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createActivityReporter } from './activity.mjs';
import { createSessionFileObserver } from './session-observation-file.mjs';
import { createSessionActivityRecorder } from './session-activity.mjs';
import { readConnectionIdentity } from './connection-identity.mjs';
import { createNativeUsageDelivery } from './session-usage-delivery.mjs';
import { createSessionUsageOutbox } from './session-usage-outbox.mjs';
import { createSessionProcessMonitor } from './session-process.mjs';

/** Passive observations and fenced usage reporting; never permission to run a model. */
export async function startWatchObservations(options) {
  const { client, sessionId, sessionFile, cwd, server, token, directory, signal } = options;
  if (!['codex', 'claude-code'].includes(client) || !sessionId || !sessionFile || !cwd || !isAbsolute(sessionFile) || !isAbsolute(cwd) || !signal) {
    throw new Error('watch --report requires --client codex|claude-code, --session <UUID>, --session-file <absolute path> and --cwd <absolute repository path>.');
  }
  const observe = createSessionFileObserver(sessionFile, { client, sessionId, cwd, signal });
  const clientProcess = createSessionProcessMonitor(options.sessionPid);
  const baseline = await observe();
  if (clientProcess && !observe.isVerified()) throw new Error('Process monitoring requires a log with verified session and repository identity.');
  let lastTurn = JSON.stringify(observe.turnState());
  let lastWorkspace = JSON.stringify(observe.workspaceMetadata());
  signal.throwIfAborted();
  const connectionIdentity = await readConnectionIdentity({ server, token, signal });
  // Stop may arrive after identity validation but before this await resumes.
  // Do not attach a listener to an already-aborted signal and start a new loop.
  signal.throwIfAborted();
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener('abort', stop, { once: true });
  const scope = createHash('sha256').update(JSON.stringify([new URL(server).origin, connectionIdentity.projectId, connectionIdentity.agentId, client, sessionId.toLowerCase()])).digest('hex');
  let reporter;
  const status = (state, reason) => options.onStatus?.({ state, ...(reason ? { reason } : {}), ...(observe.workspaceMetadata() ? { native_workspace: observe.workspaceMetadata() } : {}) });
  const fail = error => {
    if (controller.signal.aborted) return;
    if (error.permanent || error.retryable !== true) {
      status('paused', [401, 403].includes(error.status) ? 'authentication_required' : 'observation_error');
      controller.abort();
      if ([401, 403].includes(error.status)) options.onAuthenticationFailure?.();
    } else status('retrying', 'delivery_unavailable');
  };
  try {
    reporter = createActivityReporter({ server, token, connectionIdentity, statePath: join(directory, `observations-${scope.slice(0, 20)}.json`), signal: controller.signal,
      onError: error => fail(error.permanent ? error : Object.assign(error, { retryable: true })) });
    const recorder = createSessionActivityRecorder({ client, sessionId, connectionScope: scope, reporter });
    recorder.record(baseline);
    let lastAllowance = null;
    const reportAllowance = () => {
      if (!connectionIdentity.subscriptionAllowance) return;
      const allowance = observe.allowanceSnapshot(), key = JSON.stringify(allowance);
      if (allowance && key !== lastAllowance && reporter.record({ kind: 'allowance_reported', allowance }, { runId: sessionId })) lastAllowance = key;
    };
    reportAllowance();
    if (clientProcess) reporter.record({ kind: 'session_started' }, { runId: sessionId });
    const delivery = connectionIdentity.nativeAccounting ? createNativeUsageDelivery({ server, token, ...connectionIdentity, source: 'client_json', nativeSession: { client, id: sessionId }, signal: controller.signal }) : null;
    const outbox = delivery ? createSessionUsageOutbox({ statePath: join(directory, `usage-${scope.slice(0, 20)}.json`), client, sessionId, connectionScope: delivery.connectionScope }) : null;
    outbox?.record(baseline);
    let billingPaused = false;
    status('waiting');
    const run = (async () => {
      while (!controller.signal.aborted) {
        await delay(30_000, undefined, { signal: controller.signal });
        const ended = clientProcess?.ended();
        const snapshot = await observe();
        controller.signal.throwIfAborted();
        const accepted = recorder.record(snapshot);
        reportAllowance();
        if (outbox && !billingPaused) {
          outbox.record(snapshot);
          try { await outbox.flush(report => delivery.deliver(report, controller.signal)); }
          catch (error) {
            if (controller.signal.aborted) throw error;
            if ([401, 403].includes(error.status)) throw error;
            if (error.retryable !== true) billingPaused = true;
            options.onStatus?.({ billing: billingPaused ? 'paused' : 'retrying', reason: error.status === 409 ? 'another_accounting_reporter' : 'usage_delivery_unavailable' });
          }
        }
        const workspace = observe.workspaceMetadata();
        const workspaceKey = JSON.stringify(workspace);
        const workspaceAccepted = workspace && workspaceKey !== lastWorkspace && reporter.record({ kind: 'workspace_observed', workspace }, { runId: sessionId });
        if (workspaceAccepted) lastWorkspace = workspaceKey;
        // Publish the latest explicit turn state after usage so a completed
        // turn is not made to look active by its final token observation.
        const turn = observe.turnState();
        const turnKey = JSON.stringify(turn);
        // The native watch is one session-scoped activity stream. Keep its
        // lifecycle and counters together: the hub selects usage by runId.
        // The turn identity above still detects distinct turns of the same kind.
        const taskId = options.currentTask?.();
        // Provider counters may arrive in a later scan than task_complete.
        // Restore the explicit state after those counters as well.
        if (turn && (turnKey !== lastTurn || accepted || workspaceAccepted) && reporter.record({ kind: turn.kind }, { runId: sessionId, ...(taskId ? { taskId } : {}) })) lastTurn = turnKey;
        if (ended) {
          reporter.record({ kind: 'session_ended' }, { runId: sessionId });
          await reporter.flush();
          status('stopped', 'native_session_ended');
          options.onSessionEnd?.();
          break;
        }
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
