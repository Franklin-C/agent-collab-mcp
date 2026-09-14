import { createHash } from 'node:crypto';

const fields = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = () => { throw new Error('Session usage baseline is invalid or belongs to another observation.'); };
const zero = row => ({ model: row.model, token_semantics: row.token_semantics, ...Object.fromEntries(fields.map(field => [field, 0])) });

function rows(value) {
  if (!Array.isArray(value) || value.length > 64) fail();
  const seen = new Set();
  return value.map(row => {
    if (!row || typeof row.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,79}$/.test(row.model)
      || seen.has(row.model) || !['inclusive', 'anthropic'].includes(row.token_semantics)
      || fields.some(field => !Number.isSafeInteger(row[field]) || row[field] < 0)
      || row.token_semantics === 'inclusive' && row.cache_read_tokens > row.input_tokens
      || !Number.isSafeInteger(row.input_tokens + row.output_tokens + (row.token_semantics === 'anthropic' ? row.cache_read_tokens + row.cache_write_tokens : 0))) fail();
    seen.add(row.model);
    return { model: row.model, token_semantics: row.token_semantics, ...Object.fromEntries(fields.map(field => [field, row[field]])) };
  }).sort((a, b) => a.model < b.model ? -1 : a.model > b.model ? 1 : 0);
}

/**
 * Pure transition for a persisted observation window. The first snapshot is a
 * baseline, not billable history. Persist state AND reports in one transaction
 * before delivery; replays then have identical cumulative values and event IDs.
 * This does not grant accounting authority or coordinate another reporter.
 */
export function advanceSessionUsageWindow(saved, snapshot, { client, sessionId, connectionScope }) {
  if (!['codex', 'claude-code'].includes(client) || typeof sessionId !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sessionId)
    || typeof connectionScope !== 'string' || !/^[a-f0-9]{64}$/.test(connectionScope)) fail();
  const identity = hash([client, sessionId, connectionScope]);
  if (saved !== null && saved !== undefined && (saved.version !== 1 || saved.identity !== identity)) fail();
  const baseline = saved ? rows(saved.baseline) : null;
  const previous = saved ? rows(saved.latest) : null;
  if (baseline && (baseline.some(row => !previous.some(prior => prior.model === row.model))
    || saved.window !== hash([identity, baseline]))) fail();
  if (previous) for (const prior of previous) {
    const start = baseline.find(row => row.model === prior.model) ?? zero(prior);
    if (prior.token_semantics !== (client === 'codex' ? 'inclusive' : 'anthropic')
      || start.token_semantics !== prior.token_semantics || fields.some(field => prior[field] < start[field])) fail();
  }
  // A fresh native log can exist before its first verified provider response.
  if (snapshot === null) return { state: saved ? { version: 1, identity, window: saved.window, baseline, latest: previous } : null, reports: [] };
  const latest = rows(snapshot);
  if (latest.some(row => row.token_semantics !== (client === 'codex' ? 'inclusive' : 'anthropic'))) fail();
  if (!saved) return { state: { version: 1, identity, window: hash([identity, latest]), baseline: latest, latest }, reports: [] };
  if (previous.some(prior => !latest.some(row => row.model === prior.model))) fail();
  const reports = [];
  for (const current of latest) {
    const start = baseline.find(row => row.model === current.model) ?? zero(current);
    const prior = previous.find(row => row.model === current.model) ?? zero(current);
    if (start.token_semantics !== current.token_semantics || prior.token_semantics !== current.token_semantics
      || fields.some(field => current[field] < prior[field] || prior[field] < start[field])) fail();
    const delta = { model: current.model, token_semantics: current.token_semantics,
      ...Object.fromEntries(fields.map(field => [field, current[field] - start[field]])) };
    // A reset or changed cache definition is not a negative price adjustment.
    rows([delta]);
    if (fields.every(field => current[field] === prior[field])) continue;
    reports.push({ ...delta, cumulative: true, session_id: `native-${saved.window}`,
      event_id: hash([saved.window, delta]) });
  }
  return { state: { version: 1, identity, window: saved.window, baseline, latest }, reports };
}
