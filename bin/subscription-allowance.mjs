const providers = ['codex', 'claude', 'gemini'];
const names = ['primary', 'secondary', 'five_hour', 'seven_day'];
export function safeAllowance(raw) {
  const at = Date.parse(raw?.observedAt);
  if (!providers.includes(raw?.provider) || !Number.isFinite(at) || !Array.isArray(raw.windows) || raw.windows.length > 4) return null;
  const seen = new Set(), windows = [];
  for (const row of raw.windows) {
    const reset = row?.resetsAt === null ? null : Date.parse(row?.resetsAt);
    if (!names.includes(row?.name) || seen.has(row.name) || typeof row.limited !== 'boolean' || !(row.remainingPercent === null || Number.isFinite(row.remainingPercent) && row.remainingPercent >= 0 && row.remainingPercent <= 100)
      || !(reset === null || Number.isFinite(reset) && reset > at && reset <= at + 31 * 86400_000)) return null;
    seen.add(row.name);
    windows.push({ name: row.name, remainingPercent: row.remainingPercent, resetsAt: reset === null ? null : new Date(reset).toISOString(), limited: row.limited });
  }
  return { provider: raw.provider, observedAt: new Date(at).toISOString(), windows };
}

/** Only provider quota fields, never token counts or context percentages. */
export function createNativeAllowance(client) {
  let latest = null;
  return {
    observe(record) {
      if (client !== 'codex' || record?.type !== 'event_msg' || record.payload?.type !== 'token_count') return;
      const limits = record.payload.rate_limits;
      const at = Date.parse(record.timestamp);
      if (!limits || !Number.isFinite(at)) return;
      const windows = [];
      for (const name of ['primary', 'secondary']) {
        const row = limits[name];
        if (!row) continue;
        const used = row.used_percent ?? row.usedPercent, resets = row.resets_at ?? row.resetsAt;
        if (!Number.isFinite(used) || used < 0 || used > 100 || !Number.isSafeInteger(resets) || resets * 1000 <= at || resets * 1000 > at + 31 * 86400_000) continue;
        windows.push({ name, remainingPercent: 100 - used, resetsAt: new Date(resets * 1000).toISOString(), limited: used >= 100 });
      }
      const report = safeAllowance({ provider: 'codex', observedAt: record.timestamp, windows });
      if (report && (!latest || at >= Date.parse(latest.observedAt))) latest = report;
    },
    snapshot() { return latest; },
  };
}
