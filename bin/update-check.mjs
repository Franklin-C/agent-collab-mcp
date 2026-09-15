import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const repository = 'https://github.com/Franklin-C/agent-collab-mcp';
const api = 'https://api.github.com/repos/Franklin-C/agent-collab-mcp/releases';
const source = 'github-releases-v1';
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const parts = version => typeof version === 'string' && versionPattern.test(version)
  && version.split('.').every(part => Number.isSafeInteger(Number(part))) ? version.split('.').map(Number) : null;
export async function checkUpdate({ force = false, fetcher = fetch, log = console.error } = {}) {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (manifest.repository?.url !== `git+${repository}.git` || !parts(manifest.version)) return { status: 'unavailable' };
  const directory = join(homedir(), '.agent-collab');
  const cache = join(directory, 'update-check.json');
  const backoff = join(directory, 'update-check-backoff.json');
  const save = (path, value) => { mkdirSync(directory, { recursive: true, mode: 0o700 }); writeFileSync(path, JSON.stringify({ source, repository, name: manifest.name, at: Date.now(), ...value }), { mode: 0o600 }); };
  try {
    if (!force && existsSync(backoff)) {
      let previous;
      try { previous = JSON.parse(readFileSync(backoff, 'utf8')); } catch { /* Retry unreadable local state. */ }
      const age = Date.now() - previous?.at;
      if (previous?.source === source && previous?.repository === repository && previous?.name === manifest.name
        && Number.isFinite(previous.at) && Number.isFinite(previous.delay) && previous.delay > 0 && previous.delay <= 86400000
        && age >= 0 && age < previous.delay && ['unreleased', 'unavailable'].includes(previous.status)) return { status: previous.status, ...(previous.status === 'unreleased' ? { current: manifest.version } : {}) };
    }
    if (!force && existsSync(cache)) {
      let previous = null;
      try { previous = JSON.parse(readFileSync(cache, 'utf8')); } catch { /* Recheck a cache that cannot be read. */ }
      const age = Number.isFinite(previous?.at) ? Date.now() - previous.at : NaN;
      if (previous?.source === source && previous?.repository === repository && previous?.name === manifest.name && age >= 0 && age < 86400000) return { status: 'cached' };
    }
    const response = await fetcher(`${api}/latest`, { signal: AbortSignal.timeout(5000), redirect: 'error', headers: { Accept: 'application/vnd.github+json' } });
    if ([403, 404, 429].includes(response.status)) {
      const retry = response.headers.get('retry-after');
      const requested = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : 0;
      const delay = Math.min(86400000, Math.max(response.status === 404 ? 900000 : 300000, Number.isFinite(requested) ? requested : 0));
      const status = response.status === 404 ? 'unreleased' : 'unavailable';
      save(backoff, { status, delay });
      return { status, ...(status === 'unreleased' ? { current: manifest.version } : {}) };
    }
    if (!response.ok) return { status: 'unavailable' };
    const latest = await response.json();
    const version = typeof latest?.tag_name === 'string' ? latest.tag_name.replace(/^v/, '') : null;
    const a = parts(version), b = parts(manifest.version);
    if (!a || !Number.isSafeInteger(latest.id) || latest.id <= 0 || latest.draft !== false || latest.prerelease !== false
      || latest.url !== `${api}/${latest.id}` || latest.html_url !== `${repository}/releases/tag/${latest.tag_name}`) throw new Error('Release identity does not match this source.');
    save(cache, {});
    // A forced successful check also clears an earlier negative result.
    if (existsSync(backoff)) writeFileSync(backoff, '{}', { mode: 0o600 });
    const newer = a[0] > b[0] || a[0] === b[0] && (a[1] > b[1] || a[1] === b[1] && a[2] > b[2]);
    if (newer) log(`Agent Collab ${version} is available. Review ${latest.html_url} for source and installation instructions. Running workers are not upgraded automatically.`);
    return { status: newer ? 'update' : 'current', current: manifest.version, latest: version };
  } catch { return { status: 'unavailable' }; }
}
