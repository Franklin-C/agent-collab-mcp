import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const kinds = new Set(['run_started', 'run_finished', 'run_failed', 'run_stopped', 'tool_started', 'tool_finished', 'file_changed', 'usage_reported', 'needs_permission', 'needs_authentication', 'waiting', 'waiting_review', 'waiting_dependency']);
const families = new Set(['command', 'file', 'mcp', 'search', 'other']);
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const validCount = value => Number.isSafeInteger(value) && value >= 0;

/** Deliberately excludes prompts, tool arguments/results, paths, messages and credentials. */
export function safeActivity(raw) {
  if (!raw || !kinds.has(raw.kind)) return null;
  const event = { kind: raw.kind };
  if (families.has(raw.tool)) event.tool = raw.tool;
  if (['succeeded', 'failed'].includes(raw.result)) event.result = raw.result;
  if (raw.kind === 'usage_reported' && validCount(raw.inputTokens) && validCount(raw.outputTokens) && ['turn', 'run', 'session'].includes(raw.usageScope)) {
    event.inputTokens = raw.inputTokens; event.outputTokens = raw.outputTokens;
    if (validCount(raw.cachedInputTokens)) event.cachedInputTokens = raw.cachedInputTokens;
    if (['turn', 'run', 'session'].includes(raw.usageScope)) event.usageScope = raw.usageScope;
  } else if (raw.kind === 'usage_reported') return null;
  return event;
}

/** One reporter belongs to one locked runner. A stable sequence makes lost acknowledgements harmless. */
export function createActivityReporter(options) {
  const server = new URL(options.server);
  if (server.protocol !== 'https:' && !(server.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(server.hostname))) throw new Error('Activity reporting requires HTTPS or a loopback development server.');
  if (!options.token || !options.statePath || server.username || server.password) throw new Error('Activity reporting requires a token, safe server URL and private state path.');
  const scope = createHash('sha256').update(`${server.origin}:${options.token}`).digest('hex');
  const now = options.now ?? Date.now;
  const maxPending = options.maxPending ?? 512;
  if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > 512) throw new Error('Activity outbox capacity must be between 1 and 512.');
  let state = existsSync(options.statePath) ? JSON.parse(readFileSync(options.statePath, 'utf8')) : { version: 1, scope, runtimeId: randomUUID(), nextSequence: 1, pending: [] };
  if (state.version !== 1 || state.scope !== scope || !safeId(state.runtimeId) || !Number.isSafeInteger(state.nextSequence) || state.nextSequence < 1 || !Array.isArray(state.pending) || state.pending.length > 512) throw new Error('Activity state belongs to another connection or is invalid.');
  if (state.pending.some((item, index) => !Number.isSafeInteger(item.sequence) || item.sequence < 1 || item.sequence >= state.nextSequence || (index > 0 && item.sequence <= state.pending[index - 1].sequence) || !safeId(item.runId) || !Number.isFinite(Date.parse(item.occurredAt)) || !safeActivity(item) || (item.taskId !== undefined && !safeId(item.taskId)))) throw new Error('Activity outbox is invalid; retain it for inspection.');
  // Re-sanitize disk content too: never upload an unexpected property added to an outbox.
  state.pending = state.pending.map(item => ({ ...safeActivity(item), runId: item.runId, sequence: item.sequence, occurredAt: item.occurredAt, ...(item.taskId ? { taskId: item.taskId } : {}) }));
  const persist = () => {
    mkdirSync(dirname(options.statePath), { recursive: true, mode: 0o700 });
    const temp = `${options.statePath}.tmp`;
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 }); renameSync(temp, options.statePath);
  };
  persist();
  let inflight = null, closed = false, failures = 0, retryAt = 0;
  const reportFailure = error => options.onError?.(error);
  const flush = () => {
    if (inflight) return inflight;
    inflight = (async () => {
      // A bounded flush never monopolizes the runner when a long offline backlog returns.
      for (let batch = 0; batch < 4 && state.pending.length; batch++) {
        const events = state.pending.slice(0, 50);
        const response = await (options.fetch ?? fetch)(`${server.origin}/api/agent/activity`, { method: 'POST', headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ runtimeId: state.runtimeId, events }), signal: AbortSignal.timeout(10000), redirect: 'error' });
        if (!response.ok) throw new Error(`Activity delivery failed (${response.status}); pending events retained.`);
        const acknowledgement = await response.json();
        if (!Number.isSafeInteger(acknowledgement.acceptedThrough) || acknowledgement.acceptedThrough < events.at(-1).sequence || acknowledgement.acceptedThrough >= state.nextSequence) throw new Error('Invalid activity acknowledgement; pending events retained.');
        state.pending = state.pending.filter(event => event.sequence > acknowledgement.acceptedThrough); persist();
      }
      failures = 0; retryAt = 0;
    })().catch(error => { failures++; retryAt = now() + Math.min(300000, 5000 * 2 ** Math.min(failures, 6)); throw error; }).finally(() => { inflight = null; });
    return inflight;
  };
  const tick = () => { if (now() >= retryAt) void flush().catch(reportFailure); };
  const interval = setInterval(tick, Math.max(1000, options.flushIntervalMs ?? 5000)); interval.unref();
  return {
    runtimeId: state.runtimeId,
    record(raw, context) {
      if (closed) return false;
      const event = safeActivity(raw);
      if (!event || !safeId(context?.runId) || (context.taskId !== undefined && !safeId(context.taskId))) return false;
      if (state.pending.length >= maxPending) { reportFailure(new Error('Activity outbox is full; additional observations are paused until delivery recovers.')); return false; }
      state.pending.push({ ...event, runId: context.runId, sequence: state.nextSequence++, occurredAt: new Date(now()).toISOString(), ...(context.taskId ? { taskId: context.taskId } : {}) }); persist();
      if (['needs_permission', 'needs_authentication', 'run_failed', 'run_stopped'].includes(event.kind)) tick();
      return true;
    },
    flush,
    async close() { closed = true; clearInterval(interval); await flush(); },
  };
}

/** Structured transport events only. Natural-language claims never become execution evidence. */
export function clientActivity(client, raw) {
  const event = raw?.msg ?? raw;
  if (!event || typeof event !== 'object') return [];
  if (client === 'codex' && ['item.started', 'item.completed'].includes(event.type)) {
    const item = event.item;
    const tool = { command_execution: 'command', mcp_tool_call: 'mcp', web_search: 'search', file_change: 'file' }[item?.type];
    if (!tool) return [];
    if (event.type === 'item.started') return [{ kind: 'tool_started', tool }];
    const failed = item.status === 'failed' || (Number.isInteger(item.exit_code) && item.exit_code !== 0);
    return [{ kind: item.type === 'file_change' && !failed ? 'file_changed' : 'tool_finished', tool, result: failed ? 'failed' : 'succeeded' }];
  }
  if (client === 'claude-code' && event.type === 'assistant') return (event.message?.content ?? []).filter(block => block.type === 'tool_use').map(() => ({ kind: 'tool_started', tool: 'other' }));
  if (client === 'claude-code' && event.type === 'user') return (event.message?.content ?? []).filter(block => block.type === 'tool_result').map(block => ({ kind: 'tool_finished', tool: 'other', result: block.is_error === true ? 'failed' : 'succeeded' }));
  if (client === 'gemini-cli' && event.type === 'tool_use') return [{ kind: 'tool_started', tool: 'other' }];
  if (client === 'gemini-cli' && event.type === 'tool_result') return [{ kind: 'tool_finished', tool: 'other', result: event.status === 'error' ? 'failed' : 'succeeded' }];
  return [];
}

export function clientUsageActivity(client, raw) {
  const event = raw?.msg ?? raw;
  let inputTokens, outputTokens, cachedInputTokens, usageScope;
  if (client === 'codex' && event?.type === 'turn.completed') {
    ({ input_tokens: inputTokens, output_tokens: outputTokens, cached_input_tokens: cachedInputTokens } = event.usage ?? {}); usageScope = 'turn';
  } else if (client === 'codex' && event?.type === 'ehgi.codex_usage_recovery') {
    ({ input_tokens: inputTokens, output_tokens: outputTokens, cached_input_tokens: cachedInputTokens } = event.run_usage ?? {}); usageScope = 'run';
  } else if (client === 'gemini-cli' && event?.type === 'result') {
    ({ input_tokens: inputTokens, output_tokens: outputTokens, cached: cachedInputTokens } = event.stats ?? {}); usageScope = 'run';
  } else if (client === 'claude-code' && event?.type === 'result' && event.modelUsage) {
    const models = Object.values(event.modelUsage);
    if (!models.length || models.some(model => !validCount(model?.inputTokens) || !validCount(model?.outputTokens))) return [];
    inputTokens = models.reduce((sum, model) => sum + model.inputTokens, 0);
    outputTokens = models.reduce((sum, model) => sum + model.outputTokens, 0);
    if (models.every(model => validCount(model.cacheReadInputTokens))) cachedInputTokens = models.reduce((sum, model) => sum + model.cacheReadInputTokens, 0);
    usageScope = 'run';
  }
  const activity = safeActivity({ kind: 'usage_reported', inputTokens, outputTokens, cachedInputTokens, usageScope });
  return activity ? [activity] : [];
}
