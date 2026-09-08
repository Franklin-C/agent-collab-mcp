import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const cli = fileURLToPath(new URL('../bin/agent-collab-mcp.mjs', import.meta.url));
function fixture(run) {
  const home = mkdtempSync(join(tmpdir(), 'agent-collab-cli-'));
  try { run(home, (args) => spawnSync(process.execPath, [cli, ...args], { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, AGENT_COLLAB_TOKEN: 'test-token' }, encoding: 'utf8' })); }
  finally { rmSync(home, { recursive: true, force: true }); }
}
for (const [client, path, key] of [['cursor', '.cursor/mcp.json', 'mcpServers'], ['gemini-cli', '.gemini/settings.json', 'mcpServers'], ['windsurf', '.codeium/windsurf/mcp_config.json', 'mcpServers'], ['vscode', '.vscode/mcp.json', 'servers']]) {
  test(`${client}: preserves existing configuration and backs up before writing`, () => fixture((home, run) => {
    const file = join(home, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ existing: true, [key]: { unrelated: { url: 'https://example.org' } } }));
    assert.equal(run(['connect', '--host', 'https://example.com', '--client', client]).status, 0);
    const value = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(value.existing, true); assert.ok(value[key].unrelated); assert.ok(value[key]['agent-collab']);
    assert.ok(readdirSync(dirname(file)).some((name) => name.includes('.backup-')));
  }));
}
test('malformed JSON remains untouched', () => fixture((home, run) => {
  const file = join(home, '.cursor/mcp.json'); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, '{bad');
  assert.equal(run(['connect', '--host', 'https://example.com', '--client', 'cursor']).status, 1);
  assert.equal(readFileSync(file, 'utf8'), '{bad');
}));
test('Codex rejects a different existing host and accepts matching config', () => fixture((home, run) => {
  const args = ['connect', '--host', 'https://example.com', '--client', 'codex'];
  assert.equal(run(args).status, 0); assert.equal(run(args).status, 0);
  assert.equal(run(['connect', '--host', 'https://another.example', '--client', 'codex']).status, 1);
}));
test('remote plaintext hosts are rejected', () => fixture((_home, run) => {
  assert.equal(run(['doctor', '--host', 'http://example.com']).status, 1);
}));

test('doctor completes initialization and preserves negotiated session headers', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  let initialized = false;
  const server = createServer(async (request, response) => {
    if (request.url === '/api/mcp/health') { response.end('{}'); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    response.setHeader('content-type', 'application/json');
    if (payload.method === 'initialize') { response.setHeader('Mcp-Session-Id', 'test-session'); response.end(JSON.stringify({ jsonrpc:'2.0', id:1, result:{ protocolVersion:'2025-03-26' } })); return; }
    if (request.headers['mcp-session-id'] !== 'test-session' || request.headers['mcp-protocol-version'] !== '2025-03-26') { response.writeHead(400).end(); return; }
    if (payload.method === 'notifications/initialized') { initialized = true; response.writeHead(202).end(); return; }
    if (!initialized) { response.writeHead(400).end(); return; }
    response.end(JSON.stringify({ jsonrpc:'2.0', id:2, result:{ tools:[{name:'get_briefing'}] } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const child = spawn(process.execPath, [cli, 'doctor', '--host', `http://127.0.0.1:${server.address().port}`], { env: { ...process.env, AGENT_COLLAB_TOKEN: 'test-token' } });
    let output=''; child.stdout.on('data', chunk=>output+=chunk); child.stderr.on('data', chunk=>output+=chunk);
    const code = await new Promise(resolve => child.on('exit', resolve));
    assert.equal(code,0,output); assert.equal(JSON.parse(output).ready,true); assert.ok(initialized);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('Codex doctor recognizes current and legacy tables without changing config', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const server = createServer(async (request, response) => {
    if (request.url === '/api/mcp/health') { response.end('{}'); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    response.setHeader('content-type', 'application/json');
    if (payload.method === 'notifications/initialized') { response.writeHead(202).end(); return; }
    response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: payload.method === 'initialize' ? { protocolVersion: '2025-03-26' } : { tools: [{ name: 'get_briefing' }] } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${server.address().port}`;
  const values = `url = "${host}/api/mcp"\nbearer_token_env_var = "AGENT_COLLAB_TOKEN"`;
  const cases = [
    ['hyphenated', `[mcp_servers.agent-collab]\n${values}`, true],
    ['legacy', `[mcp_servers.agent_collab]\n${values}`, true],
    ['quoted', `[mcp_servers."agent-collab"] # Codex\n${values}\n`, true],
    ['literal quoted', `[mcp_servers.'agent_collab']\nurl='${host}/api/mcp'\nbearer_token_env_var='AGENT_COLLAB_TOKEN'\n`, true],
    ['wrong host', `[mcp_servers.agent-collab]\n${values.replace(host, 'https://wrong.example')}`, false],
    ['wrong token variable', `[mcp_servers.agent-collab]\n${values.replace('AGENT_COLLAB_TOKEN', 'OTHER_TOKEN')}`, false],
    ['commented values', `[mcp_servers.agent-collab]\n# ${values.replace('\n', '\n# ')}`, false],
    ['nested table', `[mcp_servers.agent-collab]\n[mcp_servers.agent-collab.env]\n${values}`, false],
    ['unrelated table', `[mcp_servers.unrelated]\n${values}`, false],
  ];
  try {
    for (const [label, config, valid] of cases) {
      const home = mkdtempSync(join(tmpdir(), 'agent-collab-doctor-'));
      try {
        mkdirSync(join(home, '.codex'));
        const path = join(home, '.codex/config.toml'); writeFileSync(path, config);
        const child = spawn(process.execPath, [cli, 'doctor', '--host', host, '--client', 'codex'], { env: { ...process.env, HOME: home, USERPROFILE: home, AGENT_COLLAB_TOKEN: 'test-token' } });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
        const code = await new Promise(resolve => child.on('exit', resolve));
        if (valid) {
          // Executable availability is a separate check (Codex need not be installed in CI).
          assert.equal(JSON.parse(stdout).configuration, 'verified', `${label}: ${stderr}`);
        } else {
          assert.equal(code, 1, label); assert.match(stderr, /configuration .* is missing or differs/, label);
        }
        assert.equal(readFileSync(path, 'utf8'), config, label);
        assert.deepEqual(readdirSync(join(home, '.codex')), ['config.toml'], label);
      } finally { rmSync(home, { recursive: true, force: true }); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
