/** Only structured provider totals; never infer token counts from text length. */
export function usageReports(client, raw, model) {
  const event = raw.msg ?? raw;
  const valid = n => Number.isSafeInteger(n) && n >= 0;
  const count = n => Number.isSafeInteger(n) && n >= 0 ? n : 0;
  if (client === 'claude-code' && event.type === 'result' && event.modelUsage) return Object.entries(event.modelUsage).filter(([,u]) => u && valid(u.inputTokens) && valid(u.outputTokens)).map(([name,u]) => ({model:name,input_tokens:count(u.inputTokens),output_tokens:count(u.outputTokens),cache_read_tokens:count(u.cacheReadInputTokens),cache_write_tokens:count(u.cacheCreationInputTokens),...(Number.isFinite(u.costUSD)&&u.costUSD>=0?{cost_usd:u.costUSD}:{}),token_semantics:'anthropic'}));
  if (client === 'codex' && event.type === 'turn.completed' && event.usage && valid(event.usage.input_tokens) && valid(event.usage.output_tokens) && model) return [{model,input_tokens:count(event.usage.input_tokens),output_tokens:count(event.usage.output_tokens),cache_read_tokens:count(event.usage.cached_input_tokens),token_semantics:'inclusive'}];
  if (client === 'gemini-cli' && event.type === 'result' && event.stats && valid(event.stats.input_tokens) && valid(event.stats.output_tokens) && model) return [{model,input_tokens:count(event.stats.input_tokens),output_tokens:count(event.stats.output_tokens),cache_read_tokens:count(event.stats.cached),token_semantics:'inclusive'}];
  return [];
}
