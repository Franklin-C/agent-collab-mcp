import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionProcessMonitor as create } from '../bin/session-process.mjs';

test('only a verified process disappearing proves session end', () => {
  let failure;
  const monitor = create(123456789, () => { if (failure) throw Object.assign(new Error('probe failed'), { code: failure }); });
  assert.equal(monitor.ended(), false);
  failure = 'EPERM'; assert.equal(monitor.ended(), false);
  failure = 'ESRCH'; assert.equal(monitor.ended(), true);
  failure = undefined; assert.equal(monitor.ended(), true);
});
test('missing or unverified PID never invents an ended session', () => {
  assert.equal(create(undefined), null);
  for (const pid of [0, -1, 1.5, NaN, process.pid]) assert.throws(() => create(pid));
  assert.throws(() => create(123456789, () => { throw Object.assign(new Error(), { code: 'ESRCH' }); }));
});
