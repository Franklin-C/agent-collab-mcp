/** Correlate usage only with an explicit supported native session identifier. */
export function nativeUsageSession(client, raw, knownSessionId) {
  if (!['codex', 'claude-code'].includes(client)) return null;
  const event = raw?.msg ?? raw;
  const id = event?.session_id ?? knownSessionId;
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) return null;
  return { client, id: id.toLowerCase() };
}
