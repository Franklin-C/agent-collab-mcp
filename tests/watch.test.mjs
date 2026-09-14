import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from 'node:crypto';
import { createActivityReporter } from '../bin/activity.mjs';

const cli = fileURLToPath(new URL("../bin/agent-collab-mcp.mjs", import.meta.url));
async function fixture(handle, verify, args = [], timeoutMs = 15000) {
  const directory = mkdtempSync(join(tmpdir(), "ehgi-watch-test-"));
  const server = createServer((request, response) => handle(request, response, directory));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(process.execPath, [cli, "watch", "--host", base, "--state", directory, ...(typeof args === 'function' ? args(directory, base) : args)], {
    env: { ...process.env, AGENT_COLLAB_TOKEN: "test-secret-never-in-status" },
  });
  let stderr = "";
  child.stderr.on("data", chunk => stderr += chunk);
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    await verify({ code, stderr, directory, status: JSON.parse(readFileSync(join(directory, "status.json"), "utf8")) });
    assert.equal(existsSync(join(directory, "watch.lock")), false);
    assert(!readFileSync(join(directory, "status.json"), "utf8").includes("test-secret"));
  } finally {
    clearTimeout(timer);
    child.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
}

test("watch recovers from a transient failure, persists events before cursor, and reports recovery", async () => {
  let calls = 0;
  let retryStatus;
  let connectedStatus;
  await fixture(async (request, response, directory) => {
    let body = ""; for await (const chunk of request) body += chunk;
    calls++;
    if (calls === 1) { response.writeHead(503, { "Retry-After": "3" }).end(); return; }
    if (calls === 2) {
      retryStatus = JSON.parse(readFileSync(join(directory, "status.json"), "utf8"));
      response.end(JSON.stringify({ next_seq: 4, events: [{ seq: 4, kind: "mention" }] })); return;
    }
    connectedStatus = JSON.parse(readFileSync(join(directory, "status.json"), "utf8"));
    assert.equal(JSON.parse(body).since_seq, 4);
    assert.equal(JSON.parse(readFileSync(join(directory, "cursor.json"))).seq, 4);
    assert.equal(JSON.parse(readFileSync(join(directory, "events-0-4.json"))).events[0].seq, 4);
    response.end(JSON.stringify({ next_seq: 4, events: [], stop_requested: true }));
  }, ({ code, stderr, status }) => {
    assert.equal(code, 0, stderr);
    assert.equal(calls, 3);
    assert.equal(retryStatus.state, "retrying");
    assert.equal(retryStatus.failures, 1);
    assert(Number.isFinite(Date.parse(retryStatus.next_retry_at)));
    assert(Date.parse(retryStatus.next_retry_at) - Date.parse(retryStatus.updated_at) >= 2900);
    assert.equal(connectedStatus.state, "connected");
    assert.equal(connectedStatus.failures, 0);
    assert.equal(connectedStatus.next_retry_at, null);
    assert.equal(status.state, "stopped");
    assert.equal(status.reason, "stop_requested");
    assert.equal(status.automatic_client_resume, false);
    assert.match(stderr, /Watch disconnected/);
    assert.match(stderr, /Watch reconnected/);
  });
});

for (const [httpStatus, reason] of [[401, "authentication_required"], [403, "authentication_required"], [409, "lease_conflict"], [404, "configuration_required"]]) {
  test(`watch stops safely on ${httpStatus} and records the actionable reason`, async () => {
    let calls = 0;
    await fixture((_request, response) => { calls++; response.writeHead(httpStatus).end(); }, ({ code, status }) => {
      assert.equal(code, 1);
      assert.equal(calls, 1);
      assert.equal(status.state, "stopped");
      assert.equal(status.reason, reason);
      assert.equal(status.next_retry_at, null);
    });
  });
}

test("watch --once records failure without retrying or advancing its cursor", async () => {
  await fixture((_request, response) => response.end(JSON.stringify({ next_seq: -1, events: [] })), ({ code, directory, status }) => {
    assert.equal(code, 1);
    assert.equal(status.reason, "request_failed");
    assert.equal(existsSync(join(directory, "cursor.json")), false);
  }, ["--once"]);
});

test('watch --report uploads changed native session counters without billing or private content', async () => {
  const sessionId = '01a07a24-a447-75b3-890e-ceb683c31bfe';
  const usage = input => ({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: 10, cached_input_tokens: 20 } } } });
  const packets = [];
  let pendingWatch, watchCalls = 0, billingCalls = 0;
  await fixture(async (request, response, directory) => {
    let text = ''; for await (const chunk of request) text += chunk;
    if (request.url === '/api/agent/activity') {
      const packet = JSON.parse(text); packets.push(packet);
      response.end(JSON.stringify({ acceptedThrough: packet.events.at(-1).sequence }));
      pendingWatch.end(JSON.stringify({ next_seq: 0, events: [], stop_requested: true }));
    } else if (request.url === '/api/agent/watch') {
      watchCalls++;
      assert.equal(JSON.parse(text).task_id, 'task_83');
      assert.equal(JSON.parse(text).lease_version, 5);
      if (watchCalls === 1) appendFileSync(join(directory, 'session.jsonl'), `${JSON.stringify(usage(200))}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: '01900000-0000-7000-8000-000000000099', last_agent_message: 'PRIVATE' } })}\n`);
      if (watchCalls === 1) { response.end(JSON.stringify({ next_seq: 0, events: [], stop_requested: false })); return; }
      pendingWatch = response;
    } else { billingCalls++; response.writeHead(500).end(); }
  }, ({ code, stderr, status }) => {
    assert.equal(code, 0, stderr);
    assert.equal(billingCalls, 0);
    assert.equal(status.mode, 'events_with_observations');
    assert.equal(status.automatic_client_resume, false);
    assert.equal(status.reason, 'stop_requested');
    assert.equal(packets.length, 1);
    assert.deepEqual(packets[0].events.map(event => event.kind), ['usage_reported', 'run_finished']);
    const { kind, inputTokens, outputTokens, usageScope, runId } = packets[0].events[0];
    assert.deepEqual({ kind, inputTokens, outputTokens, usageScope, runId }, { kind: 'usage_reported', inputTokens: 200, outputTokens: 10, usageScope: 'session', runId: sessionId });
    const latest = packets[0].events.at(-1);
    assert.equal(latest.taskId, 'task_83');
    assert.equal(packets[0].events[0].taskId, undefined, 'session totals must not be attributed to the current task');
    const visibleUsage = packets[0].events.find(event => event.kind === 'usage_reported' && event.runId === latest.runId);
    assert.equal(visibleUsage?.inputTokens, 200, 'turn completion must retain usage for the same native activity stream');
    assert(!JSON.stringify(packets).includes('PRIVATE'));
  }, directory => {
    const file = join(directory, 'session.jsonl');
    writeFileSync(file, [
      { type: 'session_meta', payload: { id: sessionId, cwd: directory } },
      { type: 'turn_context', payload: { model: 'gpt-6-astra' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: '01900000-0000-7000-8000-000000000099' } },
      { type: 'message', text: 'PRIVATE' }, usage(100),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    return ['--report', '--client', 'codex', '--session', sessionId, '--session-file', file, '--cwd', directory, '--task', 'task_83', '--lease', '5'];
  }, 45000);
});

test('watch --report refuses missing session identity before any network request', async () => {
  let calls = 0;
  await fixture((_request, response) => { calls++; response.writeHead(500).end(); }, ({ code, stderr, status }) => {
    assert.equal(code, 1);
    assert.equal(calls, 0);
    assert.match(stderr, /requires --client/);
    assert.equal(status.reason, 'reporting_configuration_required');
  }, ['--report']);
});

test('restarted native watch replays the exact persisted observation before collecting new work', async () => {
  const sessionId = '01a07a24-a447-75b3-890e-ceb683c31bfe';
  let original, received, pendingWatch;
  await fixture(async (request, response) => {
    if (request.url === '/api/agent/watch') { pendingWatch = response; return; }
    assert.equal(request.url, '/api/agent/activity');
    let body = ''; for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    response.end(JSON.stringify({ acceptedThrough: received.events.at(-1).sequence }));
    pendingWatch.end(JSON.stringify({ next_seq: 0, events: [], stop_requested: true }));
  }, ({ code, stderr }) => {
    assert.equal(code, 0, stderr);
    assert.deepEqual(received, { runtimeId: original.runtimeId, events: original.pending });
  }, (directory, server) => {
    const token = 'test-secret-never-in-status';
    const scope = createHash('sha256').update(`${server}:${token}:codex:${sessionId}`).digest('hex');
    const statePath = join(directory, `observations-${scope.slice(0, 20)}.json`);
    const prior = createActivityReporter({ server, token, statePath });
    prior.record({ kind: 'usage_reported', inputTokens: 200, outputTokens: 10, usageScope: 'session' }, { runId: sessionId });
    prior.stop(); // Models interruption with an unacknowledged disk outbox.
    original = JSON.parse(readFileSync(statePath, 'utf8'));
    const file = join(directory, 'session.jsonl');
    writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: directory } })}\n`);
    return ['--report', '--client', 'codex', '--session', sessionId, '--session-file', file, '--cwd', directory];
  });
});

test('native watch rejects a different session before network delivery', async () => {
  let calls = 0;
  await fixture((_request, response) => { calls++; response.writeHead(500).end(); }, ({ code, stderr, status }) => {
    assert.equal(code, 1);
    assert.equal(calls, 0);
    assert.match(stderr, /cannot be safely observed/);
    assert.equal(status.reason, 'reporting_configuration_required');
  }, directory => {
    const file = join(directory, 'session.jsonl');
    writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: 'different-session', cwd: directory } })}\n`);
    return ['--report', '--client', 'codex', '--session', '01a07a24-a447-75b3-890e-ceb683c31bfe', '--session-file', file, '--cwd', directory];
  });
});

test('watch CLI recovers its dead owner lock and resumes the saved cursor', async () => {
  await fixture(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    assert.equal(JSON.parse(body).since_seq, 12);
    response.end(JSON.stringify({ next_seq: 12, events: [], stop_requested: true }));
  }, ({ code, stderr, status }) => {
    assert.equal(code, 0, stderr);
    assert.equal(status.seq, 12);
    assert.equal(status.reason, 'stop_requested');
  }, (directory, server) => {
    const identity = createHash('sha256').update(`${server}:test-secret-never-in-status`).digest('hex').slice(0, 20);
    const module = new URL('../bin/worker-lock.mjs', import.meta.url).href;
    execFileSync(process.execPath, ['--input-type=module', '-e', `import { acquireWorkerLock } from ${JSON.stringify(module)}; acquireWorkerLock(process.argv[1], process.argv[2], { name: 'watch' });`, directory, `watch:${identity}`]);
    writeFileSync(join(directory, 'cursor.json'), JSON.stringify({ seq: 12 }));
    return [];
  });
});
