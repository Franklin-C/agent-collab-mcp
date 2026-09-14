import { createHash } from 'node:crypto';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const kinds = { task_started: 'run_started', task_complete: 'run_finished', turn_aborted: 'run_stopped' };

/** Explicit Codex turn events only. A finished turn never means session logout. */
export function createNativeTurnState(client, sessionId) {
  let latest = null;
  return {
    observe(record) {
      if (client !== 'codex' || record?.type !== 'event_msg') return;
      const event = record.payload;
      if (!Object.hasOwn(kinds, event?.type ?? '') || !uuid.test(event?.turn_id ?? '')) return;
      if (event.thread_id !== undefined && event.thread_id !== sessionId) return;
      const runId = `native-turn-${createHash('sha256').update(JSON.stringify([sessionId, event.turn_id])).digest('hex')}`;
      latest = Object.freeze({ kind: kinds[event.type], runId });
    },
    snapshot() { return latest; },
  };
}
