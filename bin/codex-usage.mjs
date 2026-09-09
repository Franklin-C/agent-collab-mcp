import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const fields = ['input_tokens', 'output_tokens', 'cached_input_tokens'];
const zero = () => Object.fromEntries(fields.map(field => [field, 0]));
const count = value => Number.isSafeInteger(value) && value >= 0;
const canonical = path => process.platform === 'win32' ? path.toLowerCase() : path;
const fail = message => Object.assign(new Error(message), { code: 'CODEX_USAGE_UNAVAILABLE', retryable: false });
const samePath = (first, second) => canonical(realpathSync(first)) === canonical(realpathSync(second));

function directory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical(realpathSync(path)) !== canonical(resolve(path))) throw fail('Codex usage directory is not an unaliased regular directory.');
}

/** UUIDv7 dates locate only this session's possible local/UTC day directories. */
export function codexSessionDates(sessionId) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(sessionId ?? '')) throw fail('Codex checkpoint recovery requires the exact UUIDv7 session identifier.');
  const timestamp = Number.parseInt(sessionId.replaceAll('-', '').slice(0, 12), 16);
  const dates = new Set();
  for (const offset of [-1, 0, 1]) {
    const date = new Date(timestamp + offset * 86400000);
    dates.add([String(date.getUTCFullYear()).padStart(4, '0'), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')].join('/'));
  }
  return [...dates];
}

/** Read one identified Codex exec rollout. Never inspect other sessions' content. */
export function readCodexUsageCheckpoint({ sessionId, cwd, env = process.env, maxBytes = 16 * 1024 * 1024 }) {
  try { return readCheckpoint({ sessionId, cwd, env, maxBytes }); }
  catch (error) { if (error.code === 'CODEX_USAGE_UNAVAILABLE') throw error; throw fail('Codex checkpoint could not be safely read.'); }
}

function readCheckpoint({ sessionId, cwd, env, maxBytes }) {
  const dates = codexSessionDates(sessionId), home = resolve(env.CODEX_HOME || join(homedir(), '.codex'));
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) throw fail('Invalid Codex checkpoint read bound.');
  const candidates = [];
  try {
    directory(home); directory(join(home, 'sessions'));
    for (const date of dates) {
      const [year, month, day] = date.split('/');
      let path = join(home, 'sessions');
      try { for (const part of [year, month, day]) { path = join(path, part); directory(path); } }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (!entry.name.endsWith(`-${sessionId}.jsonl`)) continue;
        if (!/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-f0-9-]+\.jsonl$/i.test(entry.name)) throw fail('Unexpected exact-session Codex checkpoint filename.');
        candidates.push(join(path, entry.name));
      }
    }
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!candidates.length) return null;
  if (candidates.length !== 1) throw fail('Multiple exact-session Codex checkpoints are ambiguous.');
  const path = candidates[0], before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) throw fail('Codex checkpoint is linked, nonregular or exceeds the read bound.');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let text;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maxBytes) throw fail('Codex checkpoint changed during safe opening.');
    const buffer = Buffer.alloc(opened.size); let offset = 0;
    while (offset < buffer.length) { const read = readSync(fd, buffer, offset, buffer.length - offset, offset); if (!read) break; offset += read; }
    text = buffer.subarray(0, offset).toString('utf8');
  } finally { closeSync(fd); }
  let metadata = false, latest = null;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim(); if (!line) continue;
    let event;
    try { event = JSON.parse(line); }
    catch { if (index === lines.length - 1 && !text.endsWith('\n')) break; throw fail('Codex checkpoint contains malformed complete records.'); }
    if (!metadata) {
      const value = event?.payload;
      if (event?.type !== 'session_meta' || value?.id !== sessionId || value.session_id !== undefined && value.session_id !== sessionId || value.source !== 'exec' || typeof value.cwd !== 'string' || !samePath(value.cwd, cwd)) throw fail('Codex checkpoint does not match this exact exec session and workspace.');
      metadata = true; continue;
    }
    if (event?.type !== 'event_msg' || event.payload?.type !== 'token_count' || !event.payload.info?.total_token_usage) continue;
    const totals = event.payload.info.total_token_usage;
    if (!fields.every(field => count(totals[field])) || totals.cached_input_tokens > totals.input_tokens || !Number.isSafeInteger(totals.input_tokens + totals.output_tokens)) throw fail('Codex checkpoint token counters are invalid.');
    if (latest && fields.some(field => totals[field] < latest.totals[field])) throw fail('Codex checkpoint counters regressed; recovery cannot safely infer a delta.');
    latest = { sessionId, reportedAt: event.timestamp ?? null, totals: Object.fromEntries(fields.map(field => [field, totals[field]])) };
  }
  if (!metadata) throw fail('Codex checkpoint lacks exact-session metadata.');
  return latest;
}

/** Account only the provider checkpoint portion absent from stdout this invocation. */
export function createCodexUsageRecovery(options) {
  const read = options.readCheckpoint ?? readCodexUsageCheckpoint;
  let sessionId = options.sessionId ?? null, sessionChanged = false, recoveryAttempted = false;
  const baseline = sessionId ? read({ ...options, sessionId }) : null;
  if (sessionId && !baseline) throw fail('An exact-session Codex usage baseline is required before resuming.');
  const reported = zero(), seen = new Set();
  return {
    observe(raw) {
      const event = raw?.msg ?? raw;
      if (event?.type === 'thread.started' && typeof event.thread_id === 'string') {
        if (sessionId && sessionId !== event.thread_id) sessionChanged = true;
        else sessionId = event.thread_id;
      }
      if (event?.type !== 'turn.completed' || !count(event.usage?.input_tokens) || !count(event.usage?.output_tokens)) return;
      const id = event.uuid ?? event.event_id;
      if (typeof id === 'string' && id.length) { if (seen.has(id)) return; seen.add(id); }
      for (const field of fields) reported[field] += count(event.usage[field]) ? event.usage[field] : 0;
    },
    recover() {
      if (recoveryAttempted) return null;
      recoveryAttempted = true;
      if (!sessionId) return null; // No provider session identifier was observed.
      if (sessionChanged) throw fail('Codex changed session identity during an invocation.');
      const checkpoint = read({ ...options, sessionId });
      if (!checkpoint) throw fail('The exact Codex session has no available provider usage checkpoint.');
      const start = baseline?.totals ?? zero();
      if (fields.some(field => checkpoint.totals[field] < start[field])) throw fail('Codex session counters reset after the resume baseline.');
      const runUsage = Object.fromEntries(fields.map(field => [field, checkpoint.totals[field] - start[field]]));
      // A checkpoint can lag the final stdout event. It adds no newer evidence.
      if (fields.some(field => runUsage[field] < reported[field])) return null;
      const usage = Object.fromEntries(fields.map(field => [field, runUsage[field] - reported[field]]));
      if (!fields.some(field => usage[field] > 0)) return null;
      if (usage.cached_input_tokens > usage.input_tokens) throw fail('Codex checkpoint cache counters cannot be reconciled with stdout.');
      const digest = createHash('sha256').update(JSON.stringify([sessionId, start, reported, checkpoint.totals])).digest('hex');
      return { type: 'ehgi.codex_usage_recovery', event_id: `checkpoint-${digest}`, usage, run_usage: runUsage };
    },
  };
}
