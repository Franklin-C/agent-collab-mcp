import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { recoverWatch } from '../bin/watch-recovery.mjs';

function fixture(outcomes) {
  const launches = [], waits = [];
  const spawn = (entry, args, options) => {
    launches.push({ entry, args, options });
    const child = new EventEmitter();
    child.kill = signal => queueMicrotask(() => child.emit('close', null, signal));
    const next = outcomes.shift();
    queueMicrotask(() => {
      if (next.terminal) child.emit('message', { type: 'watch_terminal' });
      if (next.error) child.emit('error', next.error);
      else child.emit('close', next.code ?? null, next.signal ?? null);
    });
    return child;
  };
  return { spawn, wait: async ms => { waits.push(ms); }, launches, waits };
}

test('unexpected exits retry only the same watch child with bounded backoff', async () => {
  const f = fixture([{ code: 1 }, { signal: 'SIGKILL' }, { code: 9 }, { code: 1 }]);
  assert.equal(await recoverWatch('/cli.mjs', ['watch', '--keep-alive', 'false'], f), 1);
  assert.equal(f.launches.length, 4);
  assert.deepEqual(f.waits, [1000, 4000, 15000]);
  for (const launch of f.launches) {
    assert.deepEqual(launch.args, ['watch', '--keep-alive', 'false']);
    assert.equal(launch.options.windowsHide, true);
    assert.equal(launch.options.stdio[3], 'ipc');
  }
});

for (const outcome of [{ code: 0 }, { code: 1, terminal: true }, { code: 130 }, { code: 143 }, { signal: 'SIGINT' }, { signal: 'SIGTERM' }]) {
  test(`intentional exit is never restarted: ${JSON.stringify(outcome)}`, async () => {
    const f = fixture([outcome]);
    await recoverWatch('/cli.mjs', ['watch'], f);
    assert.equal(f.launches.length, 1);
    assert.equal(f.waits.length, 0);
  });
}

test('cancellation during backoff never launches another child', async () => {
  const controller = new AbortController(), f = fixture([{ code: 1 }]);
  assert.equal(await recoverWatch('/cli.mjs', ['watch'], { ...f, signal: controller.signal, wait: async () => controller.abort() }), 143);
  assert.equal(f.launches.length, 1);
});

test('failure to launch is surfaced without retrying', async () => {
  const error = new Error('ENOENT'), f = fixture([{ error }]);
  await assert.rejects(recoverWatch('/missing', ['watch'], f), error);
  assert.equal(f.launches.length, 1);
});

test('cancellation terminates the owned child and waits for its exit', async () => {
  const controller = new AbortController();
  let killed = null;
  const code = await recoverWatch('/cli.mjs', ['watch'], {
    signal: controller.signal,
    spawn: () => {
      const child = new EventEmitter();
      child.kill = signal => { killed = signal; queueMicrotask(() => child.emit('close', 143, null)); };
      queueMicrotask(() => controller.abort());
      return child;
    },
  });
  assert.equal(killed, 'SIGTERM');
  assert.equal(code, 143);
});
