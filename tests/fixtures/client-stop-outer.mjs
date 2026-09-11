import { networkAttempts } from './client-exit-network-guard.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClient } from '../../bin/client-adapters.mjs';
import { createUsageCollector } from '../../bin/usage.mjs';

const [directory, nonce, mode = 'parent'] = process.argv.slice(2);
if (!['parent', 'late'].includes(mode) || !/^[a-f0-9-]{36}$/.test(nonce ?? '') || resolve(directory) !== directory || process.platform === 'win32') throw Error('Invalid outer Stop fixture');
const controller = new AbortController(), collect = createUsageCollector('codex', 'synthetic-counter-fixture');
const evidence = { nonce, mode, pid: process.pid, startedAt: Date.now(), activity: [], usageAttempts: [], usageAccepted: [], networkAttempts };
const save = name => writeFileSync(join(directory, `${name}.json`), JSON.stringify(evidence, null, 2));
save('outer-start');
process.on('exit', code => writeFileSync(join(directory, 'outer-exit.json'), JSON.stringify({ nonce, pid: process.pid, at: Date.now(), code })));
let output = '';
try {
  evidence.result = await runClient({ client: 'codex', executable: process.execPath, version: 'synthetic-node', resume: true }, 'Bounded local Stop fixture', {
    cwd: directory, env: process.env, signal: controller.signal, timeoutMs: 12000,
    spawn: (command, _args, options) => {
      assert.equal(command, process.execPath); assert.equal(options.detached, true);
      return spawn(command, [fileURLToPath(new URL('./client-stop-child.mjs', import.meta.url)), 'client', directory, nonce, mode], options);
    },
    onOutput: chunk => {
      output += chunk.toString();
      let end;
      while ((end = output.indexOf('\n')) >= 0) {
        const event = JSON.parse(output.slice(0, end)); output = output.slice(end + 1);
        if (event.type === 'fixture.ready') {
          assert.equal(event.nonce, nonce);
          assert.equal(controller.signal.aborted, false);
          evidence.descendantPid = event.descendantPid; evidence.stopAt = Date.now(); save('stop-requested');
          controller.abort();
        }
      }
    },
    onActivity: event => evidence.activity.push({ kind: event.kind, at: Date.now() }),
    onUsage: async raw => {
      const attempt = { id: raw.event_id, totals: raw.usage, startedAt: Date.now() }; evidence.usageAttempts.push(attempt);
      if (raw.usage.input_tokens > 10) await new Promise(done => setTimeout(done, 3000));
      evidence.usageAccepted.push({ id: raw.event_id, reports: collect(raw), acceptedAt: Date.now() });
    },
  });
  evidence.outcome = 'resolved';
} catch (error) {
  evidence.outcome = 'rejected';
  evidence.error = { name: error.name, code: error.code ?? null, retryable: error.retryable ?? null, usageRecoveryError: error.usageRecoveryError ?? null };
}
evidence.settledAt = Date.now(); save('outer-result');
// Natural outer exit is essential: no polling, sleep, IPC, process.exit or
// extra timer after settlement. The only delayed sink above is final usage.
