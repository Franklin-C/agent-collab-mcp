import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export async function checkUpdate({ force = false, fetcher = fetch, log = console.error } = {}) {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (manifest.private) return { status: 'unpublished', current: manifest.version };
  const directory = join(homedir(), '.agent-collab');
  const cache = join(directory, 'update-check.json');
  try {
    if (!force && existsSync(cache)) {
      let previous = null;
      try { previous = JSON.parse(readFileSync(cache, 'utf8')); } catch { /* Recheck a cache that cannot be read. */ }
      const age = Number.isFinite(previous?.at) ? Date.now() - previous.at : NaN;
      if (previous?.name === manifest.name && age >= 0 && age < 86400000) return { status: 'cached' };
    }
    const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/latest`, { signal: AbortSignal.timeout(5000) });
    if (response.status === 404) return { status: 'unpublished', current: manifest.version };
    if (!response.ok) return { status: 'unavailable' };
    const latest = await response.json();
    if (latest.name !== manifest.name || !/^\d+\.\d+\.\d+$/.test(latest.version) || latest.repository?.url !== manifest.repository?.url) throw new Error('Registry package identity does not match this source.');
    mkdirSync(directory, { recursive: true, mode: 0o700 }); writeFileSync(cache, JSON.stringify({ name: manifest.name, at: Date.now() }), { mode: 0o600 });
    const a = latest.version.split('.').map(Number), b = manifest.version.split('.').map(Number);
    const newer = a[0] > b[0] || a[0] === b[0] && (a[1] > b[1] || a[1] === b[1] && a[2] > b[2]);
    if (newer) log(`Agent Collab ${latest.version} is available. Review https://github.com/Franklin-C/agent-collab-mcp/releases before running npm install -g ${manifest.name}@${latest.version}.`);
    return { status: newer ? 'update' : 'current', current: manifest.version, latest: latest.version };
  } catch { return { status: 'unavailable' }; }
}
