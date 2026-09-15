import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/agent-collab-mcp.mjs", import.meta.url));
test("watch reports its loaded connector and warns once across repeated outdated responses", async () => {
  let calls = 0;
  await fixture(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const report = JSON.parse(body).connector;
    assert.match(report.version, /^\d+\.\d+\.\d+$/);
    assert.equal(report.restart_required, false);
    response.end(JSON.stringify({ next_seq:0, events:[], connector:{minimum:'999.0.0',recommended:'999.0.0'}, stop_requested:++calls === 3 }));
  }, ({code,stderr,status}) => {
    assert.equal(code,0,stderr);
    assert.equal(status.connector.state,'outdated');
    assert.equal((stderr.match(/Connector needs attention/g) ?? []).length,1);
  });
});
async function fixture(handle, verify, args = []) {
  const directory = mkdtempSync(join(tmpdir(), "ehgi-watch-test-"));
  const server = createServer((request, response) => handle(request, response, directory));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const child = spawn(process.execPath, [cli, "watch", "--host", `http://127.0.0.1:${server.address().port}`, "--state", directory, ...args], {
    env: { ...process.env, AGENT_COLLAB_TOKEN: "test-secret-never-in-status" },
  });
  let stderr = "";
  child.stderr.on("data", chunk => stderr += chunk);
  const timer = setTimeout(() => child.kill(), 15000);
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
    assert.equal(JSON.parse(body).passive, true);
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
