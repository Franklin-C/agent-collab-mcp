import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeTurnState } from '../bin/native-turn-state.mjs';
const session = '01900000-0000-7000-8000-000000000001';
const turn = '01900000-0000-7000-8000-000000000002';
const event = type => ({ type: 'event_msg', payload: { type, turn_id: turn, last_agent_message: 'PRIVATE' } });

test('explicit turn starts and ends share an identity and never imply session offline', () => {
  const state = createNativeTurnState('codex', session);
  assert.equal(state.snapshot(), null);
  state.observe(event('task_started'));
  const start = state.snapshot();
  assert.equal(start.kind, 'run_started');
  state.observe(event('task_complete'));
  assert.deepEqual(state.snapshot(), { kind: 'run_finished', runId: start.runId });
  state.observe(event('turn_aborted'));
  assert.deepEqual(state.snapshot(), { kind: 'run_stopped', runId: start.runId });
  assert.equal(JSON.stringify(state.snapshot()).includes('PRIVATE'), false);
});

test('text, malformed IDs, other clients and mismatched session events are ignored', () => {
  const state = createNativeTurnState('codex', session);
  for (const value of [{ type: 'message', text: JSON.stringify(event('task_started')) }, { type: 'event_msg', payload: { type: 'task_started', turn_id: 'fake' } }, { ...event('task_started'), payload: { ...event('task_started').payload, thread_id: 'other' } }]) state.observe(value);
  assert.equal(state.snapshot(), null);
  const claude = createNativeTurnState('claude-code', session);
  claude.observe(event('task_started'));
  assert.equal(claude.snapshot(), null);
  const other = createNativeTurnState('codex', '01900000-0000-7000-8000-000000000003');
  state.observe(event('task_started')); other.observe(event('task_started'));
  assert.notEqual(state.snapshot().runId, other.snapshot().runId);
});
