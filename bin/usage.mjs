/** Only structured provider totals; never infer token counts from text length. */
export function usageReports(client, raw, model) {
  const event = raw?.msg ?? raw;
  if (!event || typeof event !== 'object') return [];
  const valid = n => Number.isSafeInteger(n) && n >= 0;
  const count = n => Number.isSafeInteger(n) && n >= 0 ? n : 0;
  if (client === 'claude-code' && event.type === 'result' && event.modelUsage) return Object.entries(event.modelUsage).filter(([,u]) => u && valid(u.inputTokens) && valid(u.outputTokens)).map(([name,u]) => ({model:name,input_tokens:count(u.inputTokens),output_tokens:count(u.outputTokens),cache_read_tokens:count(u.cacheReadInputTokens),cache_write_tokens:count(u.cacheCreationInputTokens),...(Number.isFinite(u.costUSD)&&u.costUSD>=0?{cost_usd:u.costUSD}:{}),token_semantics:'anthropic'}));
  if (client === 'codex' && ['turn.completed', 'ehgi.codex_usage_snapshot'].includes(event.type) && event.usage && valid(event.usage.input_tokens) && valid(event.usage.output_tokens) && model) return [{model,input_tokens:count(event.usage.input_tokens),output_tokens:count(event.usage.output_tokens),cache_read_tokens:count(event.usage.cached_input_tokens),token_semantics:'inclusive',...(event.type === 'ehgi.codex_usage_snapshot' ? {cumulative:true} : {})}];
  if (client === 'gemini-cli' && event.type === 'result' && event.stats && valid(event.stats.input_tokens) && valid(event.stats.output_tokens) && model) return [{model,input_tokens:count(event.stats.input_tokens),output_tokens:count(event.stats.output_tokens),cache_read_tokens:count(event.stats.cached),token_semantics:'inclusive'}];
  return [];
}

/** One collector per invocation: retry IDs are not additional paid turns. */
export function createUsageCollector(client, model) {
  const reportedIds = new Set();
  let finalResultReported = false;
  return raw => {
    const reports = usageReports(client, raw, model);
    if (!reports.length) return [];
    const event = raw.msg ?? raw;
    const providerId = event.uuid ?? event.event_id;
    const stableId = typeof providerId === 'string' && providerId.length > 0;
    if (stableId && reportedIds.has(providerId)) return [];
    // Claude/Gemini emit one final snapshot for this invocation's steps. Codex
    // emits a delta per completed turn; equal ID-less deltas are distinct turns.
    if (client !== 'codex' && finalResultReported) return [];
    if (stableId) reportedIds.add(providerId);
    finalResultReported = true;
    return reports;
  };
}
