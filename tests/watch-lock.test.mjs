import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireWorkerLock } from '../bin/worker-lock.mjs';

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'ehgi-watch-lock-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
const options = { name: 'watch', recoverStale: true };

test('watch lock recovers after its actual child owner exits without releasing', t => {
  const path = directory(t);
  const module = new URL('../bin/worker-lock.mjs', import.meta.url).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `import { acquireWorkerLock } from ${JSON.stringify(module)}; acquireWorkerLock(process.argv[1], 'watch:fixture', { name: 'watch' });`, path]);
  const before = JSON.parse(readFileSync(join(path, 'watch.lock'), 'utf8'));
  assert.notEqual(before.pid, process.pid);
  const recovered = acquireWorkerLock(path, 'watch:fixture', options);
  assert.equal(recovered.isOwned(), true);
  assert.equal(JSON.parse(readFileSync(join(path, 'watch.lock'), 'utf8')).pid, process.pid);
  recovered.release();
  assert.equal(existsSync(join(path, 'watch.lock')), false);
  assert.equal(existsSync(join(path, 'watch.lock.guard')), false);
});

test('watch recovery preserves a live owner and its independent worker lock', t => {
  const path = directory(t);
  const worker = acquireWorkerLock(path, 'worker:fixture');
  const watch = acquireWorkerLock(path, 'watch:fixture', options);
  const before = readFileSync(join(path, 'watch.lock'), 'utf8');
  assert.throws(() => acquireWorkerLock(path, 'watch:fixture', options), /live/);
  assert.equal(readFileSync(join(path, 'watch.lock'), 'utf8'), before);
  assert.equal(worker.isOwned(), true);
  watch.release(); worker.release();
});

test('watch recovery refuses legacy, different-identity and inaccessible owners', t => {
  const path = directory(t), file = join(path, 'watch.lock');
  for (const value of ['12345', JSON.stringify({ version: 1, phase: 'idle', identity: 'other', pid: 12345, nonce: 'a'.repeat(36) })]) {
    writeFileSync(file, value);
    assert.throws(() => acquireWorkerLock(path, 'watch:fixture', options));
    assert.equal(readFileSync(file, 'utf8'), value);
  }
  const value = JSON.stringify({ version: 1, phase: 'idle', identity: 'watch:fixture', pid: 12345, nonce: 'a'.repeat(36) });
  writeFileSync(file, value);
  assert.throws(() => acquireWorkerLock(path, 'watch:fixture', { ...options, probe: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); } }));
  assert.equal(readFileSync(file, 'utf8'), value);
  assert.throws(() => acquireWorkerLock(path, 'watch:fixture', { name: '../outside' }), /Invalid local lock name/);
});
