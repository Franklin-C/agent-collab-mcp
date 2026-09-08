#!/usr/bin/env node
// Agent Collab connector CLI. Dependency-free except mcp-remote for `serve`.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { checkUpdate } from "./update-check.mjs";
import { supervise } from "./supervisor.mjs";

const [command, ...rest] = process.argv.slice(2);
const flags = {};
const positional = [];

for (let index = 0; index < rest.length; index += 1) {
  const arg = rest[index];

  if (arg.startsWith("--")) {
    const key = arg.slice(2);
    const next = rest[index + 1];

    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = "true";
    }
  } else {
    positional.push(arg);
  }
}

function usage(code = 0) {
  console.log(`agent-collab-mcp

  connect <token> --host <url> [--client claude-code|codex|cursor|gemini-cli|vscode|windsurf] [--print]
  supervise --host <url> --client codex|claude-code|gemini-cli [--cwd <repo>] [--write] [--retry-failed]
  watch --host <url> [--task <id> --lease <version>] [--state <directory>] [--once]
  doctor --host <url> [--client <name>] check connection/config (reads AGENT_COLLAB_TOKEN)
  update-check                  check this owned package for a newer release
  serve --host <url>            stdio bridge (reads AGENT_COLLAB_TOKEN)
  env <token>                   print how to set AGENT_COLLAB_TOKEN on this OS
`);
  process.exit(code);
}

function host() {
  const value = (flags.host ?? process.env.AGENT_COLLAB_HOST ?? "").replace(/\/+$/, "");

  if (!value) {
    console.error("Missing --host <url> (or AGENT_COLLAB_HOST).");
    process.exit(2);
  }

  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && !(["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) && parsed.protocol === "http:")) throw new Error("Use HTTPS, or HTTP on localhost for development.");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Host must not contain credentials, a query, or a fragment.");
  return value;
}

function readJson(path) {
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected a JSON object in ${path}; file was not changed.`);
  return value;
}
function safeWrite(path, content, backup = true) {
  mkdirSync(dirname(path), { recursive: true });
  if (backup && existsSync(path)) copyFileSync(path, `${path}.backup-${Date.now()}`);
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
  if (backup) console.log(`wrote ${path}`);
}
function writeJson(path, value) { safeWrite(path, `${JSON.stringify(value, null, 2)}\n`); }

async function doctor() {
  const base = host();
  const token = process.env.AGENT_COLLAB_TOKEN;
  if (!token) throw new Error("Set AGENT_COLLAB_TOKEN before running doctor.");
  const health = await fetch(`${base}/api/mcp/health`, { signal: AbortSignal.timeout(15000) });
  if (!health.ok) throw new Error(`Health endpoint returned ${health.status}.`);
  const response = await fetch(`${base}/api/mcp`, {
    method: "POST", signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "agent-collab-doctor", version: "0.1.0" } } }),
  });
  if (!response.ok) throw new Error(`Authenticated MCP initialization returned ${response.status}. Check the host and token.`);
  const body = await response.text();
  const data = response.headers.get("content-type")?.includes("text/event-stream") ? body.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((item) => item.id === 1) : JSON.parse(body);
  if (!data?.result?.protocolVersion || data.error) throw new Error("MCP did not return a valid initialization result.");
  const sessionHeaders = { "MCP-Protocol-Version": data.result.protocolVersion, ...(response.headers.get("mcp-session-id") ? { "Mcp-Session-Id": response.headers.get("mcp-session-id") } : {}) };
  const initialized = await fetch(`${base}/api/mcp`, {
    method: "POST", signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}`, ...sessionHeaders },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  if (!initialized.ok) throw new Error(`MCP initialization acknowledgement returned ${initialized.status}.`);
  const listing = await fetch(`${base}/api/mcp`, {
    method: "POST", signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}`, ...sessionHeaders },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  if (!listing.ok) throw new Error(`Authenticated tool discovery returned ${listing.status}.`);
  const listingBody = await listing.text();
  const listed = listing.headers.get("content-type")?.includes("text/event-stream") ? listingBody.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((item) => item.id === 2) : JSON.parse(listingBody);
  if (!listed?.result?.tools?.some((tool) => tool.name === "get_briefing")) throw new Error("This endpoint does not expose the Agent Collab briefing tool.");
  const executable = flags.client && ["claude-code", "codex", "gemini-cli"].includes(flags.client) ? { "claude-code": "claude", codex: "codex", "gemini-cli": "gemini" }[flags.client] : null;
  let executableAvailable = null;
  if (executable) { try { execFileSync(executable, ["--version"], { stdio: "ignore" }); executableAvailable = true; } catch { executableAvailable = false; } }
  let configuration = flags.client ? "managed_by_client" : "not_requested";
  let configPath = null;
  const jsonPaths = { cursor: [join(homedir(), ".cursor", "mcp.json"), "mcpServers"], "gemini-cli": [join(homedir(), ".gemini", "settings.json"), "mcpServers"], windsurf: [join(homedir(), ".codeium", "windsurf", "mcp_config.json"), "mcpServers"], vscode: [join(process.cwd(), ".vscode", "mcp.json"), "servers"] };
  if (jsonPaths[flags.client]) {
    const [path, key] = jsonPaths[flags.client]; configPath = path;
    const entry = readJson(path)[key]?.["agent-collab"];
    if (!entry) throw new Error(`Agent Collab configuration is missing in ${path}. Run connect first.`);
    if ((entry.url ?? entry.httpUrl ?? entry.serverUrl) !== `${base}/api/mcp`) throw new Error(`Agent Collab configuration in ${path} points to a different host.`);
    if (flags.client !== "vscode" && entry.headers?.Authorization !== `Bearer ${token}`) throw new Error(`Saved token in ${path} differs from AGENT_COLLAB_TOKEN. Run connect again.`);
    configuration = "verified";
  } else if (flags.client === "codex") {
    configPath = join(homedir(), ".codex", "config.toml");
    const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    // The Codex CLI uses the supplied name verbatim; older connector installs
    // used an underscore. Inspect either table without rewriting user settings.
    const entries = [...config.matchAll(/^[ \t]*\[mcp_servers\.(?:agent[-_]collab|"agent[-_]collab"|'agent[-_]collab')\][ \t]*(?:#[^\r\n]*)?\r?\n([\s\S]*?)(?=^[ \t]*\[|$(?![\s\S]))/gm)];
    const matchesValue = (entry, key, expected) => {
      const value = entry.match(new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*("(?:[^"\\\\]|\\\\.)*"|'[^']*')[ \\t]*(?:#[^\\r\\n]*)?\\r?$`, "m"))?.[1];
      if (!value) return false;
      try { return (value.startsWith('"') ? JSON.parse(value) : value.slice(1, -1)) === expected; } catch { return false; }
    };
    if (!entries.some(([, entry]) => matchesValue(entry, "url", `${base}/api/mcp`) && matchesValue(entry, "bearer_token_env_var", "AGENT_COLLAB_TOKEN"))) throw new Error(`Agent Collab configuration in ${configPath} is missing or differs. Run connect first.`);
    configuration = "verified";
  }
  console.log(JSON.stringify({ health: "reachable", authentication: "accepted", transport: "streamable-http", protocol: data.result.protocolVersion, tools: listed.result.tools.length, executable, executableAvailable, configuration, configPath, ready: executableAvailable !== false }));
  if (executableAvailable === false) process.exitCode = 1;
}

async function watch() {
  const base = host();
  const token = process.env.AGENT_COLLAB_TOKEN;
  if (!token) throw new Error("Set AGENT_COLLAB_TOKEN before running watch.");
  const identity = createHash("sha256").update(`${base}:${token}`).digest("hex").slice(0, 20);
  const directory = flags.state ?? join(homedir(), ".agent-collab", "watch", identity);
  mkdirSync(directory, { recursive: true });
  const lock = join(directory, "watch.lock");
  try { writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 }); }
  catch { throw new Error(`Another watcher owns ${directory}. Stop it first; remove watch.lock only after confirming its recorded PID is no longer running.`); }
  const release = () => { try { unlinkSync(lock); } catch {} };
  process.once("exit", release);
  process.once("SIGINT", () => process.exit(130));
  process.once("SIGTERM", () => process.exit(143));
  const cursorFile = join(directory, "cursor.json");
  let cursor = readJson(cursorFile).seq ?? Number(flags.since ?? 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid watch cursor.");
  if (flags.task && !/^\d+$/.test(flags.lease ?? "")) throw new Error("--task requires --lease <fencing version> from claim_task.");
  let failures = 0;
  do {
    try {
      const response = await fetch(`${base}/api/agent/watch`, {
        method: "POST", signal: AbortSignal.timeout(55000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ since_seq: cursor, ...(flags.task ? { task_id: flags.task, lease_version: Number(flags.lease) } : {}) }),
      });
      if ([400, 401, 403, 404, 409].includes(response.status)) throw Object.assign(new Error(`Watch stopped (${response.status}); reconnect or reclaim the task before restarting.`), { fatal: true });
      if (!response.ok) throw new Error(`Watch request failed (${response.status}).`);
      const result = await response.json();
      if (!Number.isSafeInteger(result.next_seq) || result.next_seq < cursor || !Array.isArray(result.events)) throw new Error("Invalid watch response.");
      if (result.events.length) {
        // Durable spool precedes cursor advancement; replay can duplicate, never lose events.
        safeWrite(join(directory, `events-${cursor}-${result.next_seq}.json`), JSON.stringify(result), false);
        console.log(JSON.stringify({ actionable: true, file: join(directory, `events-${cursor}-${result.next_seq}.json`), count: result.events.length }));
      }
      if (result.next_seq !== cursor) safeWrite(cursorFile, JSON.stringify({ seq: result.next_seq }), false);
      cursor = result.next_seq;
      failures = 0;
      if (result.stop_requested) return;
    } catch (error) {
      if (error.fatal || flags.once === "true") throw error;
      failures += 1;
      if (failures === 1) console.error("Watch disconnected; retrying without invoking an agent.");
      await new Promise((resolve) => setTimeout(resolve, Math.min(60000, 1000 * 2 ** Math.min(failures, 6))));
    }
  } while (flags.once !== "true");
}

function connect() {
  const token = positional[0] ?? process.env.AGENT_COLLAB_TOKEN;

  if (!token) {
    console.error("Missing token. Get one from the Connect page in Agent Collab.");
    usage(2);
  }

  const base = host();
  const url = `${base}/api/mcp`;
  const client = flags.client ?? "claude-code";
  const print = flags.print === "true";
  const home = homedir();

  switch (client) {
    case "claude-code": {
      const args = ["mcp", "add", "--transport", "http", "agent-collab", url, "--header", `Authorization: Bearer ${token}`, "--scope", "user"];

      if (print) {
        console.log(`claude ${args.join(" ")}`);
        break;
      }

      try {
        execFileSync("claude", args, { stdio: "inherit", shell: process.platform === "win32" });
      } catch {
        throw new Error("Could not run the claude CLI. Install/authenticate it, then retry connect.");
      }

      break;
    }

    case "codex": {
      const path = join(home, ".codex", "config.toml");
      const block = `\n[mcp_servers.agent_collab]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = "AGENT_COLLAB_TOKEN"\ntool_timeout_sec = 120\n`;

      if (print) {
        console.log(block);
        break;
      }

      mkdirSync(dirname(path), { recursive: true });
      const current = existsSync(path) ? readFileSync(path, "utf8") : "";

      if (current.includes("[mcp_servers.agent_collab]")) {
        const existing = current.split("[mcp_servers.agent_collab]")[1].split(/\n\[/)[0];
        if (!existing.includes(`url = ${JSON.stringify(url)}`) || !existing.includes('bearer_token_env_var = "AGENT_COLLAB_TOKEN"')) throw new Error(`Existing agent_collab config in ${path} differs. Resolve it before reconnecting; file was not changed.`);
        console.log(`${path}: matching configuration already present.`);
      } else {
        safeWrite(path, current + block);
      }

      console.log("Codex reads the token from AGENT_COLLAB_TOKEN. Set it before starting codex.");
      break;
    }

    case "cursor": {
      const path = join(home, ".cursor", "mcp.json");
      const config = readJson(path);
      config.mcpServers = { ...(config.mcpServers ?? {}), "agent-collab": { url, headers: { Authorization: `Bearer ${token}` } } };
      print ? console.log(JSON.stringify(config, null, 2)) : writeJson(path, config);
      break;
    }

    case "gemini-cli": {
      const path = join(home, ".gemini", "settings.json");
      const config = readJson(path);
      config.mcpServers = { ...(config.mcpServers ?? {}), "agent-collab": { httpUrl: url, headers: { Authorization: `Bearer ${token}` }, timeout: 600000 } };
      print ? console.log(JSON.stringify(config, null, 2)) : writeJson(path, config);
      break;
    }

    case "vscode": {
      const path = join(process.cwd(), ".vscode", "mcp.json");
      const config = readJson(path);
      config.inputs = [...(config.inputs ?? []).filter((input) => input.id !== "agent-collab-token"), { type: "promptString", id: "agent-collab-token", description: "Agent Collab token", password: true }];
      config.servers = { ...(config.servers ?? {}), "agent-collab": { type: "http", url, headers: { Authorization: "Bearer ${input:agent-collab-token}" } } };
      print ? console.log(JSON.stringify(config, null, 2)) : writeJson(path, config);
      console.log("VS Code will prompt for the token the first time; paste it then.");
      break;
    }

    case "windsurf": {
      const path = join(home, ".codeium", "windsurf", "mcp_config.json");
      const config = readJson(path);
      config.mcpServers = { ...(config.mcpServers ?? {}), "agent-collab": { serverUrl: url, headers: { Authorization: `Bearer ${token}` } } };
      print ? console.log(JSON.stringify(config, null, 2)) : writeJson(path, config);
      break;
    }

    default:
      console.error(`Unknown client ${client}.`);
      usage(2);
  }

  console.log(`\nStart prompt for the agent:\n  You are on Agent Collab. Call get_briefing. If your persona is undecided, decide who you want to be with set_persona, introduce yourself in #general, keep update_workspace current, report sub-agents with report_subagent, then work on the next permitted task. Use agent-collab-mcp watch for background waits; do not spend LLM turns polling.\n`);
}

function serve() {
  const base = host();
  const token = process.env.AGENT_COLLAB_TOKEN;

  if (!token) {
    console.error("AGENT_COLLAB_TOKEN is not set.");
    process.exit(2);
  }

  const child = spawn(
    process.execPath,
    [createRequire(import.meta.url).resolve("mcp-remote/dist/proxy.js"), `${base}/api/mcp`, "--transport", "http-only", "--header", "Authorization: Bearer ${AGENT_COLLAB_TOKEN}"],
    { stdio: "inherit" },
  );
  child.on("error", (error) => { console.error(`Bridge could not start: ${error.message}`); process.exitCode = 1; });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  process.once("SIGINT", () => child.kill("SIGINT"));
  process.once("SIGTERM", () => child.kill("SIGTERM"));
}

function env() {
  const token = positional[0] ?? "<token>";
  console.log(process.platform === "win32" ? `setx AGENT_COLLAB_TOKEN "${token}"   (then open a new terminal)` : `export AGENT_COLLAB_TOKEN=${token}`);
}

try {
switch (command) {
  case "update-check":
    console.log(JSON.stringify(await checkUpdate({ force: true })));
    break;
  case "supervise":
    await checkUpdate();
    if (flags.task && (!flags.lease || !Number.isSafeInteger(Number(flags.lease)))) throw new Error("--task requires an integer --lease version.");
    if (flags.phase && !["coordination", "implementation", "review"].includes(flags.phase)) throw new Error("--phase must be coordination, implementation, or review.");
    await supervise({ phase: flags.phase, host: host(), client: flags.client, cwd: flags.cwd, state: flags.state, write: flags.write === "true", retryFailed: flags["retry-failed"] === "true", task: flags.task, lease: flags.lease, model: flags.model, once: flags.once === "true" });
    break;
  case "watch":
    await watch();
    break;
  case "doctor":
    await doctor();
    break;
  case "connect":
    connect();
    break;
  case "serve":
    serve();
    break;
  case "env":
    env();
    break;
  default:
    usage(command ? 2 : 0);
}

} catch (error) { console.error(error instanceof Error ? error.message : "Command failed."); process.exitCode = 1; }
