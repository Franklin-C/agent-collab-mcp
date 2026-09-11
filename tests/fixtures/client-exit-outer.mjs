import { networkAttempts } from './client-exit-network-guard.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode, directory, nonce] = process.argv.slice(2);
if (!['normal', 'inherited', 'slow', 'failing'].includes(mode) || !/^[a-f0-9-]{36}$/.test(nonce ?? '') || resolve(directory) !== directory) throw Error('Invalid outer fixture');
const { runClient } = await import('../../bin/client-adapters.mjs');
const { createUsageCollector } = await import('../../bin/usage.mjs');
const collect = createUsageCollector('codex', 'synthetic-counter-fixture');
const evidence = { mode, nonce, pid: process.pid, startedAt: Date.now(), activity: [], usageAttempts: [], usageAccepted: [], networkAttempts };
const save = name => writeFileSync(join(directory, `${name}.json`), JSON.stringify(evidence, null, 2));
save('outer-start');
process.on('exit', code => writeFileSync(join(directory, 'outer-exit.json'), JSON.stringify({ nonce, pid: process.pid, at: Date.now(), code })));
try {
  evidence.result = await runClient({ client: 'codex', executable: process.execPath, version: 'synthetic-node', resume: true }, 'Bounded synthetic lifecycle fixture', {
    cwd: directory, env: process.env, timeoutMs: 12000,
    // Production polling defaults remain untouched. Only the executable is a
    // local synthetic Node child; there is no provider CLI or HTTP transport.
    spawn: (command, _args, options) => {
      assert.equal(command, process.execPath);
      return spawn(process.execPath, [fileURLToPath(new URL('./client-exit-child.mjs', import.meta.url)), mode, directory, nonce], options);
    },
    onActivity: event => evidence.activity.push({ kind: event.kind, at: Date.now() }),
    onUsage: async raw => {
      const attempt = { id: raw.event_id, totals: raw.usage, startedAt: Date.now() };
      evidence.usageAttempts.push(attempt); save('usage-progress');
      if (raw.usage.input_tokens === 12 && mode === 'slow') await new Promise(done => setTimeout(done, 3000));
      if (raw.usage.input_tokens === 12 && mode === 'failing') {
        attempt.failedAt = Date.now(); save('usage-progress'); throw Error('Synthetic final durable sink refused usage');
      }
      const reports = collect(raw);
      evidence.usageAccepted.push({ id: raw.event_id, reports, acceptedAt: Date.now() }); save('usage-progress');
    },
  });
  evidence.outcome = 'resolved';
} catch (error) {
  evidence.outcome = 'rejected';
  evidence.error = { name: error.name, code: error.code ?? null, retryable: error.retryable ?? null, usageRecoveryError: error.usageRecoveryError ?? null };
}
evidence.settledAt = Date.now(); save('outer-result');
// Natural exit is the assertion target. No polling/sleep/IPC, process.exit or
// forced exitCode is added after runClient settles. A slow usage sink above is
// the operation under test, not an unrelated handle sustaining shutdown.
