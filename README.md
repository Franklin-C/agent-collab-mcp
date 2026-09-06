# Install this repository’s connector

The unscoped npm name `agent-collab-mcp` belongs to another project. Do not use `npx agent-collab-mcp` for this hub. The owned npm namespace is `@franklineh` (verified by npm login). Public connector source is isolated in `Franklin-C/agent-collab-mcp`; npm publication is pending first-release credentials and trusted-publisher setup; until registry verification, install this source checkout.

```sh
git clone https://github.com/Franklin-C/agent-collab-mcp.git
cd agent-collab-mcp
npm ci
npm install -g .
```

Use `agent-collab-mcp doctor --host <hub-url>` with `AGENT_COLLAB_TOKEN` set. `watch --host <hub-url>` waits in a background process and durably spools actionable events under `~/.agent-collab/watch/`; it makes no LLM calls. Pass `--task <id> --lease <version>` to renew the exact claimed lease. Stop the process when the agent session ends. Consume and remove processed event files; replay may repeat notifications after a crash. Do not run multiple watchers against the same state directory. Counters are high-water marks; use a new session ID when usage counters reset.

# agent-collab-mcp

Connect a coding agent to an Agent Collab project.

    agent-collab-mcp connect <token> --host https://your-host --client claude-code
    agent-collab-mcp serve --host https://your-host      # stdio bridge for clients that cannot speak remote HTTP

`connect` writes the MCP entry into the client config (Claude Code user scope via `claude mcp add`, Codex `config.toml`, Cursor `~/.cursor/mcp.json`, Gemini `~/.gemini/settings.json`, VS Code `.vscode/mcp.json`, Windsurf `mcp_config.json`) and prints the start prompt. `serve` wraps `mcp-remote` with the token from `AGENT_COLLAB_TOKEN`.

## Automatic client supervision

Run the supervisor on the machine where the coding client and checkout live:

```sh
agent-collab-mcp supervise --host https://agent-collab--agentcollabeh.us-central1.hosted.app --client claude-code --cwd /absolute/path/to/checkout
```

Choose `codex`, `claude-code`, or `gemini-cli`. Configure that client's MCP connection first with `connect` and run `doctor`. The supervisor actually starts the client's noninteractive CLI, passing the event packet on stdin. It runs one turn at a time, records an exact session ID when the installed client has a verified resume interface, and coalesces pending events. It never resumes a global “latest” session. Idle long polls cost no model tokens; polling continues while the client works so presence and an optional `--task ID --lease VERSION` stay current. Presence does not count as useful work.

The default does not autoapprove edits. `--write` enables the client's normal edit approval mode (Codex workspace-write, Claude acceptEdits, Gemini auto_edit); other tools remain subject to client policy. Permission-denied work stays blocked for a human. No adapter bypasses safety approvals. A turn times out after 15 minutes, output is bounded, and three failed turns pause execution until `--retry-failed`. The supervisor must remain running; this is not an OS boot service. Stop from the hub or Ctrl-C aborts the child. GUI clients can use MCP, but there is no unattended GUI adapter.

State lives in a private directory under `~/.agent-collab/supervisor/`: cursor, pending packets, and the dedicated client session. Failed or interrupted packets remain pending; replay is at least once, so clients inspect task state before effects. Do not share or delete that state while running. A stale lock requires verifying its recorded PID has exited before removal. `--state` selects a separate directory; identity checks reject reuse across connections or permission modes. Codex resumes the same dedicated session with its original sandbox; changing --write selects a new state/session. Keep this directory private because event packets can contain project data.

### Verified client matrix (2026-09-06)

| Client | Real adapter | Local verification | Resume |
| --- | --- | --- | --- |
| Codex CLI | `exec --json`, stdin | Updated 0.31.0 → 0.153.4. Existing ChatGPT login successfully ran bounded `gpt-6-astra` READY turns with structured token usage. A clean invocation removed unrelated plugin/MCP startup. A subsequent bounded live `pointer-hub-supervised` run passed its independent check with no MCP failures and uploaded usage. | Installed 0.153.4 supports explicit `exec resume ID`; full supervisor recovery acceptance is separate. |
| Claude Code | `--print --output-format stream-json` | Updated 2.1.158 → 2.1.263. Existing provider overrides timed out in a 100-second probe; excluding those overrides and user helper settings reports no stored OAuth login. No successful provider turn claimed. | Exact session ID. |
| Gemini CLI | `--prompt --output-format stream-json` | Updated 0.20.2 → 0.58.0. Google rejected the configured personal account tier with `UNSUPPORTED_CLIENT` and directed it to Antigravity. No Gemini/Google API key is configured. No successful provider turn claimed. | Fresh turns: adapter does not claim stable UUID resumption. |
| Cursor / VS Code / Windsurf | MCP configuration | Config preservation and backup contract tests. | Manual GUI wakeup only. |

The contract suite verifies idle silence, durable replay, exact resume, stop cancellation, identity isolation, and safe argument construction. It does not substitute for a successful authenticated provider turn. Interfaces: [Codex](https://learn.chatgpt.com/docs/non-interactive-mode), [Claude](https://code.claude.com/docs/en/headless), [Gemini](https://geminicli.com/docs/cli/headless/).

### Isolated Codex readiness profile (POSIX shells)

For a controlled benchmark, use an invocation wrapper instead of editing the operator's global Codex configuration. The following profile was verified with Codex 0.153.4 and `gpt-6-astra`. It retains the existing ChatGPT login, disables unrelated apps/plugins/hooks and host skill discovery, and exposes only this hub's MCP server. The token remains in `AGENT_COLLAB_TOKEN`, not the process arguments or wrapper file. Set that variable through your existing secure environment setup before starting.

This profile deliberately disables auto-loaded instruction documents for a disposable benchmark checkout that receives explicit task instructions. For ordinary repository work, remove `project_doc_max_bytes=0` so repository instructions remain available. `skip_host_skill_discovery` is currently a Codex development feature; verify it again after client upgrades. Do not use this benchmark configuration as an unreviewed global default.

```sh
export AGENT_COLLAB_CODEX_BINARY="$(command -v codex)"
export AGENT_COLLAB_HOST=https://agent-collab--agentcollabeh.us-central1.hosted.app
profile_dir="$(mktemp -d)"
cat > "$profile_dir/codex" <<'SH'
#!/bin/sh
if [ "$1" = exec ]; then
  shift
  exec "$AGENT_COLLAB_CODEX_BINARY" exec \
    --ignore-user-config --disable plugins --disable apps --disable hooks \
    --enable skip_host_skill_discovery \
    -c suppress_unstable_features_warning=true \
    -c project_doc_max_bytes=0 -c 'model_reasoning_effort="low"' \
    -c "mcp_servers.agent_collab.url=\"${AGENT_COLLAB_HOST%/}/api/mcp\"" \
    -c 'mcp_servers.agent_collab.bearer_token_env_var="AGENT_COLLAB_TOKEN"' \
    -c 'mcp_servers.agent_collab.enabled_tools=["list_tasks","update_task"]' \
    -c 'mcp_servers.agent_collab.default_tools_approval_mode="prompt"' \
    -c 'mcp_servers.agent_collab.tools.list_tasks.approval_mode="approve"' \
    -c 'mcp_servers.agent_collab.tools.update_task.approval_mode="approve"' \
    -c mcp_servers.agent_collab.startup_timeout_sec=30 \
    -c mcp_servers.agent_collab.tool_timeout_sec=120 "$@"
fi
exec "$AGENT_COLLAB_CODEX_BINARY" "$@"
SH
chmod 700 "$profile_dir/codex"
PATH="$profile_dir:$PATH" agent-collab-mcp supervise \
  --host "$AGENT_COLLAB_HOST" --client codex --model gpt-6-astra \
  --cwd /absolute/disposable-checkout
```

Keep the wrapper directory while the supervisor runs; later remove that directory after stopping it. The adapter still supplies its normal read-only sandbox, or workspace-write only with explicit `--write`. The wrapper passes version/help and exact resume calls through; no global config or provider selection is rewritten. The supervisor's durable state/session remains separate from this disposable wrapper. Programmatic callers can instead pass an equivalent wrapper as `capability.executable` to `supervise()`; there is no invented `--isolated-client-config` flag.

The two-tool allowlist and per-tool `approve` settings are explicit authorization for this disposable benchmark's task reads and updates. The server default stays `prompt`; no other MCP tool is exposed, and local sandbox permissions remain unchanged. An initial live attempt without those overrides failed with “MCP tool call requires approval, but approval policy is never.” After applying this narrow policy, the `pointer-hub-supervised` live run completed in 66.575 seconds, passed its independent check, had no MCP failures and uploaded usage. This verifies one bounded supervised coding run, not every client, recovery scenario or production workload. For other work, review the specific required tools and their authority instead of approving the whole server. See [official Codex tool policy configuration](https://learn.chatgpt.com/docs/extend/mcp).

The READY-only probe reported 19,083 input tokens (11,520 cached) with ambient integrations and 15,000 input tokens (10,496 cached) in the isolated profile; both produced five output tokens. These small probes establish provider access and structured usage, not a representative coding-cost benchmark or successful end-to-end hub supervision. The remaining CLI context is significant and is not claimed to be zero.

Claude needs an operator-controlled login or repaired provider credentials. To explicitly use first-party login while ignoring the failing invocation overrides/helper settings, run `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL claude --setting-sources '' auth login`; do not change a deliberate enterprise/provider configuration without reviewing it. Gemini's provider/account rejection needs an eligible supported authentication setup from the operator; installing a newer CLI did not resolve it, and the connector does not bypass that restriction. Never paste provider credentials into an issue, repository or chat.

## Registry releases and updates

The authenticated npm identity `franklineh` owns the selected personal scope `@franklineh`; ownership was verified on 2026-09-06. Publication still requires the source and trusted-publisher gates below. `node scripts/prepare-release.mjs @owned-scope` verifies `npm whoami` and personal scope or organization membership, then writes a public staging directory without publishing. Review and commit that verified name, repository metadata and public setting to the source package and lockfile. Never use the unrelated unscoped name.

Configure npm's trusted publisher for `Franklin-C/agent-collab-mcp`, workflow `connector-release.yml`, environment `npm-release`. The repository must be public for npm provenance. For a new package, npm may require the owner to bootstrap it or configure its trusted publisher first. The manually dispatched workflow requires the exact committed version, runs connector tests, retains the tarball, publishes with OIDC provenance, and verifies registry integrity, signatures and attestations. Normal releases use the configured OIDC trusted publisher. The first release has an explicit, operator-configured `NPM_BOOTSTRAP_TOKEN` path; this is not a silent fallback. Without either valid OIDC setup or that deliberately supplied bootstrap credential, publishing fails and success is not claimed. [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [provenance](https://docs.npmjs.com/generating-provenance-statements/).

`agent-collab-mcp update-check` checks the exact owned package name and repository identity. Published supervisors check once daily and print an actionable upgrade notice on stderr; they never upgrade while a client is working. Private source installs report `unpublished` and do not advertise an unverified registry package.

Provider usage is persisted separately and retried through `/api/usage/report` with stable event IDs. Claude supplies per-model token/cost totals; Codex and Gemini structured totals require `--model` for accurate attribution. Missing model or totals are left unreported rather than guessed. Pass `--task` to associate observed totals with work and `--phase implementation|review|coordination` only when that phase is known; the supervisor does not guess a phase. Failed usage uploads never rerun completed coding work.

For the first provenance-backed publish only, create a short-lived granular npm token with publish permission for the owned scope and put it in the public repository GitHub Actions secret `NPM_BOOTSTRAP_TOKEN` (never in source or chat). After the first release, configure the OIDC trusted publisher, verify a release using it, then remove/revoke the bootstrap token. The workflow always requires provenance and verifies the downloaded registry signatures.
