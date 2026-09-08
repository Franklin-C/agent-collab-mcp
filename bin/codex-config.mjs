import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function codexProfileName(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('Codex --profile must be a name containing only letters, numbers, hyphens, or underscores.');
  return value;
}
export function codexConfigPath(options = {}) {
  const profile = codexProfileName(options.profile);
  const home = resolve((options.env ?? process.env).CODEX_HOME || join(homedir(), '.codex'));
  return join(home, profile ? `${profile}.config.toml` : 'config.toml');
}
function configDigest(path, required) {
  let before;
  try { before = lstatSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; if (!required) return null; throw new Error('The selected Codex profile file is missing. Create its supported <name>.config.toml file before enrollment.'); }
  if (!before.isFile() || before.isSymbolicLink() || before.size > 1024 * 1024) throw new Error('Codex configuration must be a regular file under 1 MB to verify enrollment.');
  const contents = readFileSync(path), after = lstatSync(path);
  if (!after.isFile() || after.isSymbolicLink() || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Codex configuration changed while being read; retry enrollment after saving it.');
  return createHash('sha256').update(contents).digest('hex');
}
/** Local fingerprints detect changed selections; they are never uploaded and
 * do not pretend to resolve Codex's managed/project permission layers. */
export function codexConfigurationBinding(options = {}) {
  const base = codexConfigPath({ env: options.env }), profile = codexProfileName(options.profile);
  const path = codexConfigPath(options);
  const baseDigest = configDigest(base, false), profileDigest = profile ? configDigest(path, true) : null;
  let home = resolve(path, '..');
  try { home = realpathSync(home); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { home, baseDigest, profile, profileDigest };
}

const tables = /^[ \t]*\[mcp_servers\.(agent[-_]collab|"agent[-_]collab"|'agent[-_]collab')\][ \t]*(?:#[^\r\n]*)?\r?\n([\s\S]*?)(?=^[ \t]*\[|$(?![\s\S]))/gm;
export function configureCodex(current, url, options = {}) {
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
  const inherited = [...(options.inherited ?? '').matchAll(tables)];
  if (inherited.length > 1) throw new Error('Multiple inherited EhGI MCP entries found. Keep one connection before adding a profile override.');
  const name = inherited[0]?.[1] ?? 'agent_collab';
  return `${current}\n[mcp_servers.${name}]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = "AGENT_COLLAB_TOKEN"\ntool_timeout_sec = 120\n`;
}
