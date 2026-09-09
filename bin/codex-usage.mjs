import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';

const fields = ['input_tokens', 'output_tokens', 'cached_input_tokens'];
const zero = () => Object.fromEntries(fields.map(field => [field, 0]));
const count = value => Number.isSafeInteger(value) && value >= 0;
const canonical = path => process.platform === 'win32' ? path.toLowerCase() : path;
const fail = message => Object.assign(new Error(message), { code: 'CODEX_USAGE_UNAVAILABLE', retryable: false });
const digest = value => createHash('sha256').update(value).digest('hex');
const atLeast = (a, b) => fields.every(field => a[field] >= b[field]);
const equal = (a, b) => fields.every(field => a[field] === b[field]);
function counters(value) {
  if (!value || !fields.every(field => count(value[field])) || value.cached_input_tokens > value.input_tokens || !Number.isSafeInteger(value.input_tokens + value.output_tokens)) throw fail('Codex provider token counters are invalid.');
  return Object.fromEntries(fields.map(field => [field, value[field]]));
}
const difference = (a, b) => counters(Object.fromEntries(fields.map(field => [field, a[field] - b[field]])));

async function directory(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical(await realpath(path)) !== canonical(resolve(path))) throw fail('Codex usage directory is not an unaliased regular directory.');
}

/** UUIDv7 dates locate only this session's possible local/UTC day directories. */
export function codexSessionDates(sessionId) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(sessionId ?? '')) throw fail('Codex usage requires the exact UUIDv7 session identifier.');
  const timestamp = Number.parseInt(sessionId.replaceAll('-', '').slice(0, 12), 16);
  return [-1, 0, 1].map(offset => new Date(timestamp + offset * 86400000).toISOString().slice(0, 10).replaceAll('-', '/'));
}

/** One reader per invocation. Only the identified file's counters leave it. */
export function createCodexCheckpointReader({ cwd, env = process.env, maxBytes = 16 * 1024 * 1024 }) {
  const home = resolve(env.CODEX_HOME || join(homedir(), '.codex'));
  let previous = null, reading = null, identity = null;
  async function read(sessionId) {
    const dates = codexSessionDates(sessionId);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) throw fail('Invalid Codex checkpoint read bound.');
    const candidates = [];
    try {
      await directory(home); await directory(join(home, 'sessions'));
      let entries = 0;
      for (const date of dates) {
        let path = join(home, 'sessions');
        try { for (const part of date.split('/')) { path = join(path, part); await directory(path); } }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        for await (const entry of await opendir(path)) {
          if (++entries > 16384) throw fail('Codex exact-session directory lookup exceeds its entry bound.');
          if (!entry.name.endsWith(`-${sessionId}.jsonl`)) continue;
          if (!/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-f0-9-]+\.jsonl$/i.test(entry.name)) throw fail('Unexpected exact-session Codex checkpoint filename.');
          candidates.push(join(path, entry.name));
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!candidates.length) {
      if (previous) throw fail('The observed exact-session Codex checkpoint disappeared.');
      return null;
    }
    if (candidates.length !== 1) throw fail('Multiple exact-session Codex checkpoints are ambiguous.');
    const path = candidates[0], before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) throw fail('Codex checkpoint is linked, nonregular or exceeds the read bound.');
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let buffer, opened;
    try {
      opened = await file.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maxBytes) throw fail('Codex checkpoint changed during safe opening.');
      if (previous && (previous.path !== path || previous.sessionId !== sessionId || previous.dev !== opened.dev || previous.ino !== opened.ino || previous.birthtimeMs !== opened.birthtimeMs || previous.size > opened.size)) throw fail('Codex checkpoint was replaced or truncated during this invocation.');
      buffer = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, Math.min(65536, buffer.length - offset), offset);
        if (!bytesRead) throw fail('Codex checkpoint was truncated during reading.');
        offset += bytesRead;
      }
      const after = await lstat(path);
      if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || after.dev !== opened.dev || after.ino !== opened.ino || after.birthtimeMs !== opened.birthtimeMs || after.size < opened.size) throw fail('Codex checkpoint changed during reading.');
    } finally { await file.close(); }
    if (previous && digest(buffer.subarray(0, previous.size)) !== previous.digest) throw fail('Codex checkpoint previously observed bytes changed.');
    const text = buffer.toString('utf8'), lines = text.split('\n');
    let metadata = false, latest = null;
    for (let index = 0; index < lines.length; index++) {
      if (index % 256 === 0) await setImmediate();
      const line = lines[index].trim(); if (!line) continue;
      // Only newline-terminated records are committed provider evidence.
      if (index === lines.length - 1 && !text.endsWith('\n')) break;
      let event;
      try { event = JSON.parse(line); } catch { throw fail('Codex checkpoint contains malformed complete records.'); }
      if (!metadata) {
        const value = event?.payload;
        if (event?.type !== 'session_meta' || value?.id !== sessionId || value.session_id !== undefined && value.session_id !== sessionId || value.source !== 'exec' || typeof value.cwd !== 'string' || canonical(await realpath(value.cwd)) !== canonical(await realpath(cwd))) throw fail('Codex checkpoint does not match this exact exec session and workspace.');
        metadata = true; continue;
      }
      if (event?.type !== 'event_msg' || event.payload?.type !== 'token_count' || !event.payload.info?.total_token_usage) continue;
      const totals = counters(event.payload.info.total_token_usage);
      if (latest && !atLeast(totals, latest.totals)) throw fail('Codex checkpoint counters regressed.');
      latest = { sessionId, reportedAt: event.timestamp ?? null, totals };
    }
    if (!metadata && text.includes('\n')) throw fail('Codex checkpoint lacks exact-session metadata.');
    previous = { path, sessionId, dev: opened.dev, ino: opened.ino, birthtimeMs: opened.birthtimeMs, size: buffer.length, digest: digest(buffer) };
    return latest;
  }
  return sessionId => {
    if (identity && identity !== sessionId) return Promise.reject(fail('Codex checkpoint reader cannot change session identity.'));
    identity = sessionId;
    if (reading) return reading;
    reading = read(sessionId).catch(error => { throw error.code === 'CODEX_USAGE_UNAVAILABLE' ? error : fail('Codex checkpoint could not be safely read.'); }).finally(() => { reading = null; });
    return reading;
  };
}

/** Single accounting authority for stdout and native checkpoints this invocation. */
export async function createCodexUsageNormalizer(options) {
  const read = options.readCheckpoint ?? createCodexCheckpointReader(options);
  const readTimeoutMs = options.readTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(readTimeoutMs) || readTimeoutMs < 10 || readTimeoutMs > 30000) throw fail('Invalid Codex checkpoint read deadline.');
  const boundedRead = (id, signal) => new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => done(Object.assign(new Error('Codex resume baseline was cancelled before execution.'), { name: 'AbortError', retryable: false }));
    const timer = setTimeout(() => done(fail('Codex checkpoint read exceeded its deadline.')), readTimeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    // A timed-out OS read may finish later. Its result is latched out and can
    // never reach accounting; callers retain a durable pause instead of retrying.
    Promise.resolve().then(() => read(id)).then(value => done(null, value), error => done(error));
  });
  let sessionId = options.sessionId ?? null, native = null, published = zero(), stdout = zero(), closed = false, fault = null;
  const resumed = Boolean(sessionId), seen = new Set();
  if (sessionId) codexSessionDates(sessionId);
  const baseline = sessionId ? await boundedRead(sessionId, options.signal) : null;
  if (resumed && !baseline) throw fail('An exact-session Codex usage baseline is required before resuming.');
  const start = baseline ? counters(baseline.totals) : zero();
  let chain = Promise.resolve();
  const serial = fn => {
    const result = chain.then(() => { if (fault) throw fault; return fn(); });
    chain = result.catch(error => { fault = error.code === 'CODEX_USAGE_UNAVAILABLE' ? error : fail('Codex provider usage could not be durably accepted.'); });
    return result;
  };
  async function publish(usage) {
    if (atLeast(published, usage)) return;
    if (!atLeast(usage, published)) throw fail('Codex stdout and checkpoint counters are incomparable.');
    difference(usage, published);
    const event = { type: 'ehgi.codex_usage_snapshot', event_id: `checkpoint-${digest(JSON.stringify([sessionId, start, usage]))}`, usage };
    await options.onUsage(event);
    published = { ...usage }; // Advance only after the durable local sink accepts it.
  }
  async function sample(final = false, completed = false) {
    if (!sessionId) {
      if (final && completed) throw fail('Codex completed without an exact provider session identifier.');
      return;
    }
    const checkpoint = await boundedRead(sessionId);
    if (checkpoint) {
      const run = difference(counters(checkpoint.totals), start);
      if (native && !atLeast(run, native)) throw fail('Codex provider counters regressed between samples.');
      native = run;
      await publish(run);
    }
    if (final) {
      if (!completed && !checkpoint) throw fail('The interrupted Codex session has no available provider usage checkpoint.');
      // Resume stdout semantics must agree with the proven pre-spawn baseline.
      if (resumed && completed && (!native || !equal(native, stdout))) throw fail('Resumed Codex stdout does not agree with its exact-session usage baseline.');
      if (!native && equal(stdout, zero())) throw fail('The Codex session has no measurable provider usage.');
    }
  }
  return {
    observe(raw) {
      if (closed) return Promise.reject(fail('Codex usage invocation is already closed.'));
      return serial(async () => {
        const event = raw?.msg ?? raw;
        if (event?.type === 'thread.started') {
          codexSessionDates(event.thread_id);
          if (sessionId && sessionId !== event.thread_id) throw fail('Codex changed session identity during an invocation.');
          sessionId = event.thread_id;
        }
        if (event?.type !== 'turn.completed') return;
        if (!sessionId) throw fail('Codex usage arrived without an exact provider session identifier.');
        const usage = counters({ cached_input_tokens: 0, ...event.usage });
        const id = event.uuid ?? event.event_id;
        if (typeof id === 'string' && id.length) { if (seen.has(id)) return; seen.add(id); }
        stdout = counters(Object.fromEntries(fields.map(field => [field, stdout[field] + usage[field]])));
        if (!resumed) await publish(stdout);
      });
    },
    sample() { return closed ? chain : serial(() => sample()); },
    finish({ completed = false } = {}) {
      if (closed) return chain.then(() => { if (fault) throw fault; });
      closed = true;
      return serial(() => sample(true, completed));
    },
  };
}
