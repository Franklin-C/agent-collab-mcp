import { createHash } from 'node:crypto';
import { requestWorkerApi } from './worker.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const countFields = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'];
const invalid = () => new Error('Native usage delivery requires verified report metadata.');

/** Construct transport only. Callers must establish exclusive accounting authority before sending. */
export function createNativeUsageDelivery(options) {
  options = { ...options };
  const server = new URL(options.server);
  if (server.username || server.password || server.search || server.hash || server.pathname !== '/'
    || server.protocol !== 'https:' && !(server.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(server.hostname))) throw invalid();
  if (typeof options.token !== 'string' || !options.token || /[\r\n]/.test(options.token)
    || typeof options.projectId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(options.projectId)
    || typeof options.agentId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(options.agentId)
    || !['cli_stream', 'client_json'].includes(options.source)) throw invalid();
  // The caller must obtain project/agent identity from authenticated setup.
  // Credentials authorize delivery; rotating one must not reset the baseline
  // or abandon an unacknowledged report. Keep project and source boundaries.
  const connectionScope = hash([server.origin, options.projectId, options.agentId, options.source]);
  return {
    connectionScope,
    async deliver(raw, cycleSignal) {
      if (!raw || raw.cumulative !== true || !/^native-[a-f0-9]{64}$/.test(raw.session_id ?? '')
        || typeof raw.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,79}$/.test(raw.model)
        || !['inclusive', 'anthropic'].includes(raw.token_semantics)
        || countFields.some(field => !Number.isSafeInteger(raw[field]) || raw[field] < 0)
        || raw.token_semantics === 'inclusive' && raw.cache_read_tokens > raw.input_tokens
        || !Number.isSafeInteger(raw.input_tokens + raw.output_tokens + (raw.token_semantics === 'anthropic' ? raw.cache_read_tokens + raw.cache_write_tokens : 0))) throw invalid();
      const delta = { model: raw.model, token_semantics: raw.token_semantics, ...Object.fromEntries(countFields.map(field => [field, raw[field]])) };
      if (raw.event_id !== hash([raw.session_id.slice(7), delta])) throw invalid();
      const body = { ...delta, cumulative: true, session_id: raw.session_id, event_id: raw.event_id, source: options.source };
      let result;
      try {
        const signals = [options.signal, cycleSignal].filter(Boolean);
        const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
        result = await requestWorkerApi({ host: server.origin, token: options.token, signal, fetch: options.fetch, wait: options.wait }, '/api/usage/report', body);
      } catch (error) {
        // Remote error bodies and underlying diagnostics are not status metadata.
        throw Object.assign(new Error('Native usage delivery failed; the pending report is retained.'), {
          ...(Number.isInteger(error.status) ? { status: error.status } : {}),
          retryable: error.retryable === true,
          ...(error.name === 'AbortError' ? { name: 'AbortError' } : {}),
        });
      }
      if (result.ok !== true || typeof result.duplicate !== 'boolean' || result.id !== hash([options.agentId, body.event_id]).slice(0, 40)) {
        throw new Error('Native usage acknowledgement did not match this agent and report; pending report retained.');
      }
      return { ok: true };
    },
  };
}
