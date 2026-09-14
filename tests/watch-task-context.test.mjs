import test from 'node:test';
import assert from 'node:assert/strict';
import { createWatchTaskContext } from '../bin/watch-task-context.mjs';

test('task context requires confirmation and expires from request start', () => {
  let now = 0;
  const context = createWatchTaskContext('task_83', 5, () => now);
  assert.equal(context.current(), undefined);
  now = 25_000; context.confirm(0);
  assert.equal(context.current(), 'task_83');
  now = 55_000;
  assert.equal(context.current(), undefined);
  context.confirm(50_000);
  assert.equal(context.current(), 'task_83');
  context.clear();
  assert.equal(context.current(), undefined);
});

test('invalid task identity, fencing and clock values cannot establish context', () => {
  for (const task of ['../task', '__proto__', 'x'.repeat(129)]) assert.throws(() => createWatchTaskContext(task, 5));
  for (const lease of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => createWatchTaskContext('task', lease));
  const context = createWatchTaskContext('task', 5, () => 100);
  for (const time of [NaN, Infinity, 101]) { context.confirm(time); assert.equal(context.current(), undefined); }
  const unassigned = createWatchTaskContext(undefined, NaN, () => 100);
  unassigned.confirm(100);
  assert.equal(unassigned.current(), undefined);
});
