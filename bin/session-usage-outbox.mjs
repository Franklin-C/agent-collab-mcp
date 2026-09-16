import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { advanceSessionUsageWindow } from './session-usage-window.mjs';

const failure = () => new Error('Native usage outbox is invalid or could not be saved; retained state requires inspection.');
const canonical = path => process.platform === 'win32' ? path.toLowerCase() : path;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;

/**
 * One locked watcher owns this outbox. State and cumulative pending reports move
 * together in an atomic rename. Delivery is injected: no network, model calls,
 * authority grants or automatic timers are created by this storage component.
 */
export function createSessionUsageOutbox({ statePath, ...identity }) {
  if (typeof statePath !== 'string' || !statePath) throw failure();
  const path = resolve(statePath), parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const checkParent = () => { if (canonical(realpathSync(parent)) !== canonical(parent)) throw failure(); };
  const checkFile = () => {
    try { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw failure(); return stat; }
    catch (error) { if (error.code === 'ENOENT') return null; throw failure(); }
  };
  checkParent();
  let state = { version: 1, window: null, pending: [] }, fault = null, inflight = null;
  const before = checkFile();
  if (before) {
    let descriptor;
    try {
      descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(descriptor);
      if (!sameFile(before, opened) || opened.nlink !== 1 || opened.size > 1024 * 1024) throw failure();
      state = JSON.parse(readFileSync(descriptor, 'utf8'));
      const after = checkFile();
      if (!after || !sameFile(opened, after) || after.size !== opened.size) throw failure();
    } catch { throw failure(); } finally { if (descriptor !== undefined) closeSync(descriptor); }
  }
  if (state?.version !== 1 || !Array.isArray(state.pending) || state.pending.length > 64) throw failure();
  const window = advanceSessionUsageWindow(state.window, null, identity).state;
  const expected = window ? advanceSessionUsageWindow({ ...window, latest: window.baseline }, window.latest, identity).reports : [];
  const seen = new Set();
  const pending = state.pending.map(report => {
    const exact = expected.find(row => row.model === report?.model && row.event_id === report.event_id);
    if (!exact || seen.has(exact.model) || Object.keys(exact).some(key => exact[key] !== report[key])) throw failure();
    seen.add(exact.model);
    return exact; // Unknown disk properties cannot become uploaded content.
  });
  state = { version: 1, window, pending };
  function save(next) {
    if (fault) throw fault;
    const temporary = `${path}.${randomUUID()}.tmp`;
    let descriptor;
    try {
      checkParent(); checkFile();
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify(next)); fsyncSync(descriptor);
      closeSync(descriptor); descriptor = undefined;
      renameSync(temporary, path);
      state = next;
    } catch {
      fault = failure(); throw fault;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(temporary); } catch { /* Only this unique temporary is eligible for cleanup. */ }
    }
  }
  save(state);
  return {
    record(snapshot) {
      if (fault) throw fault;
      const next = advanceSessionUsageWindow(state.window, snapshot, identity);
      const byModel = new Map(state.pending.map(report => [report.model, report]));
      for (const report of next.reports) byModel.set(report.model, report);
      // Only the latest cumulative total is needed during a long disconnection.
      save({ version: 1, window: next.state, pending: [...byModel.values()] });
      return next.reports.length;
    },
    pendingCount() { return state.pending.length; },
    flush(deliver) {
      if (inflight) return inflight;
      if (fault) return Promise.reject(fault);
      if (typeof deliver !== 'function') return Promise.reject(new Error('An authorized delivery callback is required.'));
      inflight = (async () => {
        // A bounded snapshot cannot be prolonged indefinitely by new observations.
        for (const report of [...state.pending]) {
          const acknowledgement = await deliver({ ...report });
          if (acknowledgement?.ok !== true) throw new Error('Usage acknowledgement was not accepted; report retained.');
          save({ ...state, pending: state.pending.filter(row => row.event_id !== report.event_id) });
        }
      })().finally(() => { inflight = null; });
      return inflight;
    },
  };
}
