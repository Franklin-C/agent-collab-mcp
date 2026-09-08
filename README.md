# EhGI connector 0.3.0

Connect coding clients to EhGI, verify their execution permissions, and run fresh
assignments through an operator-started companion. The owned npm package name is
`@franklineh/agent-collab-mcp`. The unscoped `agent-collab-mcp` package belongs to
another project; do not install it for this hub.

A source version is not evidence that npm publication succeeded. Until the exact
registry release is verified, install the reviewed source checkout:

```sh
git clone https://github.com/Franklin-C/agent-collab-mcp.git
cd agent-collab-mcp
npm ci
npm install -g .
```

## Connection and enrollment

Set `AGENT_COLLAB_TOKEN` privately in the environment and complete the client's
provider login. Each agent needs its own token and state directory. Replace the
paths and model below before running:

```sh
agent-collab-mcp doctor --host https://ehgi.ai --client codex --report
agent-collab-mcp enroll --host https://ehgi.ai --client codex --repo /absolute/checkout --state /absolute/private-worker-state --model YOUR_MODEL --write --configure
agent-collab-mcp worker --host https://ehgi.ai --client codex --repo /absolute/checkout --state /absolute/private-worker-state --model YOUR_MODEL --write
```

`--configure` writes the client's MCP connection using the environment token.
Omit it when Connect setup is already complete. `enroll --start` starts the worker
after a successful probe. `--executable /absolute/client` selects a dedicated
native executable or supported Node entrypoint; Windows npm shims are resolved
to verified package entrypoints without feeding commands through `cmd.exe`.

Enrollment starts the actual client in a detached worktree. It must return an
expiring challenge through MCP and create a random local proof file. The state
records the client version and verified repository. Failed probes remain
unverified and retain their evidence. `doctor` checks connectivity/configuration
but cannot prove the client's tool approvals or ability to execute work.

`--write` selects the normal client workspace-edit mode. It does not grant MCP,
account or publication permissions. Codex and Gemini workers require `--model`
for usage attribution. Missing provider login or approval remains actionable
setup work; the connector never disables approval controls to get past it.

Use a dedicated client profile with repository access and only the required MCP
tools approved. Run enrollment against that exact profile; keep global approval
policy unchanged. In a local diagnostic, Codex 0.153.4 completed its probe in
44.13 seconds with `--approve-for-me`, the Windows unelevated sandbox and two
approved MCP probe tools. Those scoped diagnostic options are not the default
adapter command. Workspace-write mode alone did not prove execution permission;
the tested `never` policy could block even local reads.

`connect <token> --host <url> --client <name>` remains available for explicit
configuration. It preserves existing client configuration and makes backups.
`serve --host <url>` bridges stdio-only clients through `mcp-remote` using the
environment token. Antigravity uses `serverUrl`; Muse Code requires schema
version 1; configuration support does not imply unattended execution support.

## Assignment workers

The host enables **Automatic assignments** in **Workforce → Workers**, with
per-run time, reported-cost and attempt limits. Otherwise the worker can consume
explicitly queued managed jobs without scheduling automatic work.

Each managed assignment starts a fresh session and isolated Git worktree. Its
packet includes the task or coordination action, relevant replies, destinations
and limits. Agents ask questions in task threads, use Plan for decisions, submit
reviews in merge requests, put suggestions in Improve and record discoveries in
memory. Acknowledged handoffs are archived locally; MCP task/review updates and
acceptance evidence remain authoritative.

The worker renews fenced leases, persists bounded recovery checkpoints and
provider usage, and reports blockers. Independent workers can run concurrently.
Idle polling makes no model calls. A `more_work` handoff can continue within its
attempt limit; relevant answers, dependency changes and review feedback make
blocked work eligible again. A finished client response does not imply that its
task is accepted or its changes are deployed.

Supported execution adapters are Codex CLI, Claude Code and Gemini CLI. Cursor,
VS Code, Windsurf, Antigravity, Grok Build and Muse Code have configuration
support but no verified unattended adapter here. A GUI session requires manual
resumption unless its client provides a supported execution interface.

## User startup

Install startup only after enrolling the exact client and state directory:

```sh
agent-collab-mcp startup --install --state /absolute/private-worker-state --repo /absolute/checkout --host https://ehgi.ai --client codex --model YOUR_MODEL --write
agent-collab-mcp startup --state /absolute/private-worker-state
agent-collab-mcp startup --uninstall --state /absolute/private-worker-state
```

Add `--executable` when enrollment used a dedicated installation. Installation
checks the client version, repository/token identity and credential read-back.
It registers the next user login and does not launch a nested background worker.

| Platform | User startup | Credential storage |
| --- | --- | --- |
| Windows | Limited interactive-user scheduled task | DPAPI, current user |
| macOS | User LaunchAgent | Login Keychain |
| Linux | systemd user service | Secret Service via `secret-tool` |

The launcher retries classified connection failures at most three times, after
1, 4 and 15 seconds. Stop/pause, revoked access, approval requests, lock conflicts
and unknown failures remain final; idle retries make no model calls. Startup
recovers a versioned worker lock only when its identity matches and the OS proves
its saved PID is absent. Live/reused/inaccessible PIDs, legacy locks and abandoned
acquisition guards are retained. Native services do not repeatedly restart an
exited or killed launcher.

If a user service manager, keyring or provider authorization is unavailable,
repair it and verify a real assignment. This source includes generation,
escaping, recovery and lock tests; it does not claim native startup acceptance on
each operating system. Uninstall preserves recovery worktrees, checkpoints and
the stored credential.

## Event supervision and recovery

`supervise` remains available for event-driven client turns:

```sh
agent-collab-mcp supervise --host https://ehgi.ai --client claude-code --cwd /absolute/checkout --state /absolute/supervisor-state --write
```

Fresh sessions are the default. Explicit `--resume` may reuse the supervisor's
exact supported session; it never resumes a global latest session. `watch --host
<url>` only spools events and makes no model calls. Both can renew a specific task
with `--task TASK_ID --lease VERSION`; presence alone is not a checkpoint.

The supervisor saves pending events before moving its cursor and checks stop,
authentication and the supplied lease before replaying after restart. Failed
packets remain pending. Three ordinary failures pause dispatch; a recognized
approval denial pauses immediately. Repair the cause before `--retry-failed`.
Do not share state, remove active locks or start a supervisor inside a worker.
Verify that a stale lock's recorded process has exited before removing it.

## Reviews and branch cleanup

Projects can use independent-owner review or the host-selected **Personal team**
policy for distinct agents sharing one operator. Self-review and stale-head
approval remain invalid. Author/lead/host merge permission is a separate policy.
The agent merge tool cannot override readiness; only the human host can do that.

EhGI reserves each repository while merging and rechecks the actual base ref,
head, reviews, checks and authority. Automatic branch cleanup honors the project
setting and preserves branches needed by tasks, PRs or active agents. The merge
UI and `merge_merge_request` with `{"pr_number": 123, "action": "cleanup", "dry_run": true}` support preview; set `dry_run` to `false` to apply.
Request, commit and audit history remain available after branch removal.

Local managed worktrees are cleaned separately:

```sh
agent-collab-mcp cleanup --repo /absolute/checkout --state /absolute/private-worker-state --base main
agent-collab-mcp cleanup --repo /absolute/checkout --state /absolute/private-worker-state --base main --verify-github --apply
```

Fetch the base first. The default is a dry run; `--apply` acquires the worker lock
and removes only clean, verified merged `workforce/*` worktrees inside the
selected state directory. Optional `--verify-github` uses existing `gh` login to
prove squash merges. Local ref deletion checks its expected SHA. Unpublished,
dirty, ignored, untracked, outside or active work stays intact regardless of age.
This command leaves remote branches and enrollment evidence unchanged.

## Activity, usage and release verification

Structured activity goes to the hub without additional model calls. The
allowlist includes run/tool states and provider token counts; it excludes
prompts, source, tool arguments/results, paths and credentials. Reports are
batched and retried with stable IDs. Detailed activity stays outside model
context unless an assignment needs it; reading updates still consumes tokens.

Usage is reported when the client emits it, often at turn completion. Missing
totals are not guessed. Stable usage event IDs prevent duplicate accounting on
retry, and reporting failures never justify repeating completed coding work.
Supervisor `--phase implementation|review|coordination` is optional; use it only
when the phase is known. Worker assignments supply their own phase.

The latest local probe used Codex 0.153.4 with the scoped permissions above.
Claude Code 2.1.139 was logged out; Gemini CLI 0.58.0 supported the adapter but had
no configured authentication method. These observations do not certify 0.3.0.
Rollout still needs actual enrollment, concurrent tasks, questions, reviews,
merge, recovery and Stop checks across authorized clients. The owned npm package
returned 404 at the last release check; public source/export alone is not a
successful registry publication.

`update-check` checks the exact owned npm package/repository identity and never
upgrades an active worker. The public repository's manually dispatched
`connector-release.yml` workflow requires an exact committed version, tests the
package, publishes with provenance and verifies the registry artifact. Normal
releases use configured npm OIDC trusted publishing. First publication may
require the owner's explicit bootstrap setup; a source export or passing test
is not a completed publication. Keep all release credentials out of source and
chat. [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[provenance](https://docs.npmjs.com/generating-provenance-statements/).
