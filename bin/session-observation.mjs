import { posix, win32 } from 'node:path';

const validCount = value => Number.isSafeInteger(value) && value >= 0;
const validModel = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,79}$/.test(value);
const fail = () => { throw new Error('Session observation is missing verified identity or usage metadata.'); };
const zero = () => ({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 });
const fields = Object.keys(zero());

function sameDirectory(a, b, platform) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const path = platform === 'win32' ? win32 : posix;
  if (!path.isAbsolute(a) || !path.isAbsolute(b)) return false;
  const normalize = value => platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
  return normalize(a) === normalize(b);
}
function counters(raw, client) {
  const values = {
    input_tokens: raw?.input_tokens,
    output_tokens: raw?.output_tokens,
    cache_read_tokens: client === 'codex' ? raw?.cached_input_tokens : raw?.cache_read_input_tokens,
    cache_write_tokens: client === 'codex' ? 0 : raw?.cache_creation_input_tokens,
  };
  if (fields.some(field => !validCount(values[field])) || client === 'codex' && values.cache_read_tokens > values.input_tokens) fail();
  return values;
}
function add(target, value) {
  for (const field of fields) {
    target[field] += value[field];
    if (!validCount(target[field])) fail();
  }
}

/** Pure allowlist parser. Prompts, tool arguments, code and messages never enter its output. */
export function createSessionObservationParser(client, { sessionId, cwd, platform = process.platform } = {}) {
  if (!['codex', 'claude-code'].includes(client) || typeof sessionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sessionId)
    || typeof cwd !== 'string') fail();
  const models = new Map(), messages = new Map();
  const turnModels = new Map(), responses = new Map();
  const aggregateTurns = new Set();
  let verified = false, model = null, currentTurn = null, previous = zero(), nativeRecords = false;
  const totalsFor = name => {
    if (!models.has(name)) { if (models.size >= 64) fail(); models.set(name, zero()); }
    return models.get(name);
  };
  function observe(record) {
    if (!record || typeof record !== 'object') return;
    if (client === 'codex') {
      if (record.type === 'session_meta') {
        if (verified || record.payload?.id !== sessionId || !sameDirectory(record.payload?.cwd, cwd, platform)) fail();
        verified = true;
      } else if (record.type === 'turn_context') {
        if (!verified || !validModel(record.payload?.model) || record.payload.cwd && !sameDirectory(record.payload.cwd, cwd, platform)) fail();
        model = record.payload.model;
        currentTurn = typeof record.payload.turn_id === 'string' ? record.payload.turn_id : null;
        if (typeof record.payload.turn_id === 'string') turnModels.set(record.payload.turn_id, model);
      } else if (record.type === 'token_usage_record') {
        const payload = record.payload, responseModel = turnModels.get(payload?.turn_id);
        if (!verified || payload?.thread_id !== sessionId || !responseModel || typeof payload.response_id !== 'string' || !payload.response_id || payload.response_id.length > 200) fail();
        // An aggregate already accepted for this turn may include this response.
        // Without a common response boundary, adding or subtracting it guesses.
        if (aggregateTurns.has(payload.turn_id)) throw new Error('Native usage overlaps an aggregate already observed for this turn. Reporting paused.');
        const current = counters(payload.usage, client), stamp = JSON.stringify([responseModel, current]);
        const prior = responses.get(payload.response_id);
        if (prior !== undefined && prior !== stamp) fail();
        if (prior === undefined) { responses.set(payload.response_id, stamp); add(totalsFor(responseModel), current); }
        nativeRecords = true;
      } else if (record.type === 'event_msg' && record.payload?.type === 'token_count' && record.payload.info?.total_token_usage) {
        // Current Codex emits per-response native records, followed by a UI
        // token_count whose cumulative scope may reset on resume. Count one source.
        if (nativeRecords) return;
        if (!verified || !model) fail();
        const current = counters(record.payload.info.total_token_usage, client), delta = zero();
        for (const field of fields) { delta[field] = current[field] - previous[field]; if (!validCount(delta[field])) fail(); }
        if (currentTurn && fields.some(field => delta[field] > 0)) aggregateTurns.add(currentTurn);
        add(totalsFor(model), delta);
        previous = current;
      }
    } else if (record.type === 'assistant') {
      if (record.sessionId !== sessionId || !sameDirectory(record.cwd, cwd, platform) || record.isSidechain === true) fail();
      const message = record.message;
      if (!validModel(message?.model) || typeof message.id !== 'string' || message.id.length > 200 || !message.id) fail();
      verified = true;
      const current = counters(message.usage, client), prior = messages.get(message.id);
      if (prior && prior.model !== message.model) fail();
      const merged = zero();
      for (const field of fields) merged[field] = Math.max(prior?.usage[field] ?? 0, current[field]);
      messages.set(message.id, { model: message.model, usage: merged });
    }
  }
  function snapshot() {
  if (!verified) return null;
  const totals = client === 'codex' ? models : new Map();
  if (client === 'claude-code') for (const message of messages.values()) {
    if (!totals.has(message.model)) { if (totals.size >= 64) fail(); totals.set(message.model, zero()); }
    add(totals.get(message.model), message.usage);
  }
  return [...totals].map(([model, usage]) => {
    if (!validCount(usage.input_tokens + usage.output_tokens + (client === 'claude-code' ? usage.cache_read_tokens + usage.cache_write_tokens : 0))
      || client === 'codex' && usage.cache_read_tokens > usage.input_tokens) fail();
    return { model, ...usage, token_semantics: client === 'codex' ? 'inclusive' : 'anthropic' };
  });
  }
  return { observe, snapshot, isVerified: () => verified };
}

export function parseSessionObservation(client, records, options) {
  if (!Array.isArray(records) || records.length > 100_000) fail();
  const parser = createSessionObservationParser(client, options);
  for (const record of records) parser.observe(record);
  return parser.snapshot();
}
