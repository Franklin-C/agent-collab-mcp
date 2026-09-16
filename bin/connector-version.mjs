import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const manifest = new URL('../package.json', import.meta.url);
function fingerprint() {
  const hash = createHash('sha256').update(readFileSync(manifest));
  for (const name of readdirSync(new URL('.', import.meta.url)).filter(n => n.endsWith('.mjs')).sort()) {
    hash.update(name).update(readFileSync(new URL(name, import.meta.url)));
  }
  return hash.digest('hex');
}
// Capture what this process loaded, not the version currently on disk.
export const loadedVersion = JSON.parse(readFileSync(manifest, 'utf8')).version;
const loadedFingerprint = fingerprint();
const parts = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
  && value.split('.').every(n => Number.isSafeInteger(Number(n))) ? value.split('.').map(Number) : null;
export function belowMinimum(actual, minimum) {
  const a = parts(actual), b = parts(minimum);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i]; }
  return false;
}
export function createConnectorDiagnostics({ version = loadedVersion, changed = () => {
  try { return fingerprint() !== loadedFingerprint; } catch { return true; }
}, log = console.error } = {}) {
  let warned = false;
  return {
    report() { return { version, restart_required: changed() }; },
    observe(policy) {
      const restart = changed();
      const outdated = belowMinimum(version, policy?.minimum);
      const state = restart ? 'restart_required' : outdated === true ? 'outdated' : outdated === false ? 'current' : 'unknown';
      if (!warned && (restart || outdated)) {
        warned = true;
        log('Connector needs attention: ' + (restart ? 'installed source changed while this process was running.' : `loaded version ${version} is below minimum ${policy.minimum}.`)
          + ' Stop this watch/supervise process, update from https://github.com/Franklin-C/agent-collab-mcp if needed, then rerun your original watch/supervise command with the same options. No restart or authorization change was performed.');
      }
      return { version, state };
    },
  };
}
