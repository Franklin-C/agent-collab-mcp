import childProcess from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';

const calls = [];
const forbidden = [];
const block = kind => () => {
  forbidden.push(kind);
  throw new Error(`Forbidden fixture operation: ${kind}`);
};
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[key] = block(`child_process.${key}`);
net.connect = block('net.connect');
net.createConnection = block('net.createConnection');
net.Socket.prototype.connect = block('net.Socket.connect');
tls.connect = block('tls.connect');
for (const [name, module] of [['http', http], ['https', https]]) {
  module.request = block(`${name}.request`);
  module.get = block(`${name}.get`);
}
syncBuiltinESMExports();

let initialized = false;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin !== 'https://fixture.invalid') return block('unexpected_fetch_origin')();
  const method = options.method ?? 'GET';
  const payload = options.body ? JSON.parse(options.body) : null;
  const headers = new Headers(options.headers);
  calls.push({ path: url.pathname, method, rpcMethod: payload?.method ?? null });
  if (url.pathname === '/api/mcp/health' && method === 'GET') return Response.json({ ok: true });
  if (headers.get('Authorization') !== 'Bearer fixture-token') return block('unexpected_fixture_authorization')();
  if (url.pathname === '/api/agent/readiness' && method === 'POST') {
    if (!initialized || payload.tools !== 1 || payload.executable !== null) return block('invalid_readiness_body')();
    return new Response('', { status: Number(process.env.FIXTURE_READINESS_STATUS ?? 200) });
  }
  if (url.pathname !== '/api/mcp' || method !== 'POST') return block('unexpected_fetch_path')();
  if (payload.method === 'initialize') {
    return Response.json({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } }, { headers: { 'Mcp-Session-Id': 'fixture-session' } });
  }
  if (headers.get('Mcp-Session-Id') !== 'fixture-session' || headers.get('MCP-Protocol-Version') !== '2025-03-26') return block('missing_negotiated_headers')();
  if (payload.method === 'notifications/initialized') {
    initialized = true;
    return new Response('', { status: 202 });
  }
  if (payload.method === 'tools/list' && initialized) return Response.json({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'get_briefing' }] } });
  return block('unexpected_mcp_method')();
};

process.once('exit', () => {
  writeFileSync(process.env.FIXTURE_OBSERVATION, JSON.stringify({ calls, forbidden, initialized }), { flag: 'wx' });
});
