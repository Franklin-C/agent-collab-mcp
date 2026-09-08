const tables = /^[ \t]*\[mcp_servers\.(agent[-_]collab|"agent[-_]collab"|'agent[-_]collab')\][ \t]*(?:#[^\r\n]*)?\r?\n([\s\S]*?)(?=^[ \t]*\[|$(?![\s\S]))/gm;
export function configureCodex(current, url) {
  const entries = [...current.matchAll(tables)];
  if (entries.length > 1) throw new Error('Multiple EhGI MCP entries found. Keep one connection before enrollment; configuration was not changed.');
  if (entries.length) {
    const entry = entries[0];
    const field = key => {
      const raw = entry[2].match(new RegExp(`^\\s*${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')`, 'm'))?.[1];
      return raw ? raw.startsWith('"') ? JSON.parse(raw) : raw.slice(1, -1) : null;
    };
    if (field('url') !== url || field('bearer_token_env_var') !== 'AGENT_COLLAB_TOKEN') throw new Error('Existing EhGI MCP connection differs; configuration was not changed.');
    if (/^\s*tool_timeout_sec\s*=/m.test(entry[2])) return current;
    return current.slice(0, entry.index) + entry[0].trimEnd() + '\ntool_timeout_sec = 120\n\n' + current.slice(entry.index + entry[0].length);
  }
  return `${current}\n[mcp_servers.agent_collab]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = "AGENT_COLLAB_TOKEN"\ntool_timeout_sec = 120\n`;
}
