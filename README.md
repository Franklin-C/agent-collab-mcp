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
| Codex CLI | `exec --json`, stdin | Installed 0.31.0 launched; configured model rejected this old CLI and an unrelated MCP executable was missing. No successful model turn claimed. | Modern CLI explicit `exec resume ID`; this installed legacy CLI uses fresh turns. |
| Claude Code | `--print --output-format stream-json` | Installed 2.1.158 launched, emitted session ID; provider returned 401. No successful model turn claimed. | Exact session ID. |
| Gemini CLI | `--prompt --output-format stream-json` | Installed 0.20.2 launched; account requires GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID. No successful model turn claimed. | Fresh turns: installed resume help does not establish stable UUID support. |
| Cursor / VS Code / Windsurf | MCP configuration | Config preservation and backup contract tests. | Manual GUI wakeup only. |

The contract suite verifies idle silence, durable replay, exact resume, stop cancellation, identity isolation, and safe argument construction. It does not substitute for a successful authenticated provider turn. Interfaces: [Codex](https://learn.chatgpt.com/docs/non-interactive-mode), [Claude](https://code.claude.com/docs/en/headless), [Gemini](https://geminicli.com/docs/cli/headless/).

## Registry releases and updates

The authenticated npm identity `franklineh` owns the selected personal scope `@franklineh`; ownership was verified on 2026-09-06. Publication still requires the source and trusted-publisher gates below. `node scripts/prepare-release.mjs @owned-scope` verifies `npm whoami` and personal scope or organization membership, then writes a public staging directory without publishing. Review and commit that verified name, repository metadata and public setting to the source package and lockfile. Never use the unrelated unscoped name.

Configure npm's trusted publisher for `Franklin-C/agent-collab-mcp`, workflow `connector-release.yml`, environment `npm-release`. The repository must be public for npm provenance. For a new package, npm may require the owner to bootstrap it or configure its trusted publisher first. The manually dispatched workflow requires the exact committed version, runs connector tests, retains the tarball, publishes with OIDC provenance, and verifies registry integrity, signatures and attestations. A missing trusted publisher fails the release; it does not silently fall back to a token or claim success. [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [provenance](https://docs.npmjs.com/generating-provenance-statements/).

`agent-collab-mcp update-check` checks the exact owned package name and repository identity. Published supervisors check once daily and print an actionable upgrade notice on stderr; they never upgrade while a client is working. Private source installs report `unpublished` and do not advertise an unverified registry package.

Provider usage is persisted separately and retried through `/api/usage/report` with stable event IDs. Claude supplies per-model token/cost totals; Codex and Gemini structured totals require `--model` for accurate attribution. Missing model or totals are left unreported rather than guessed. Pass `--task` to associate observed totals with work and `--phase implementation|review|coordination` only when that phase is known; the supervisor does not guess a phase. Failed usage uploads never rerun completed coding work.

For the first provenance-backed publish only, create a short-lived granular npm token with publish permission for the owned scope and put it in the public repository GitHub Actions secret `NPM_BOOTSTRAP_TOKEN` (never in source or chat). After the first release, configure the OIDC trusted publisher, verify a release using it, then remove/revoke the bootstrap token. The workflow always requires provenance and verifies the downloaded registry signatures.
