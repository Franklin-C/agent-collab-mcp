# EhGI connector 0.3.1

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

For Codex, `--profile NAME` selects an existing `$CODEX_HOME/NAME.config.toml`
(`~/.codex/NAME.config.toml` by default). It requires Codex 0.134.0 or later
advertising `--profile`. Current Codex versions use separate profile files;
legacy `[profiles.NAME]` tables are not supported by this path. The connector
passes the profile to the actual CLI and leaves its permissions intact.
Without a profile, the existing workspace-write adapter behavior is unchanged.

Create a profile with permissions appropriate for the repository and account.
For an operator-authorized workflow that uses automatic approval review, the
documented current configuration is:

```toml
# $CODEX_HOME/ehgi-workforce.config.toml
approval_policy = "on-request"
approvals_reviewer = "auto_review"
default_permissions = ":workspace"
```

Automatic review still enforces the sandbox boundary and can deny requests.
Managed requirements and trusted project configuration still apply. Keep MCP
approval exceptions limited to the tools the operator authorizes; the connector
does not add approval exceptions. Native Windows also needs its normal Codex
sandbox setup. These settings and file layout are documented in OpenAI's
[profiles](https://learn.chatgpt.com/docs/config-file/config-advanced#profiles),
[automatic review](https://learn.chatgpt.com/docs/sandboxing/auto-review), and
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Use the same profile, model, executable, Codex home, and worker state throughout:

```sh
agent-collab-mcp enroll --host https://ehgi.ai --client codex --profile ehgi-workforce --repo /absolute/checkout --state /absolute/private-worker-state --model YOUR_MODEL --write --configure
agent-collab-mcp worker --host https://ehgi.ai --client codex --profile ehgi-workforce --repo /absolute/checkout --state /absolute/private-worker-state --model YOUR_MODEL --write
agent-collab-mcp startup --install --host https://ehgi.ai --client codex --profile ehgi-workforce --repo /absolute/checkout --state /absolute/private-worker-state --model YOUR_MODEL --write
```

With `--profile`, `--configure` adds the MCP connection only to that existing
profile and preserves global settings. `CODEX_HOME` also selects the authentication
home; sign in there before enrollment. The token remains in `AGENT_COLLAB_TOKEN`.
Enrollment records local hashes of the base config and selected profile plus
the client installation, version, model and Codex home. Changing those inputs
requires another real probe before work or startup installation. Config contents
and these local bindings are not uploaded. This detects configuration drift;
it does not resolve every managed or project configuration layer or certify all
future tool calls. Real enrollment proves the MCP roundtrip and local file edit.
If Codex initializes repository trust or changes configuration during the first
probe, enrollment rejects that change. Review the saved settings and rerun with
the same files; do not regenerate the original config between attempts.

On September 8, 2026, native Windows Codex 0.153.4 passed the shipped enrollment
CLI against an isolated local hub with `--profile ehgi-worker`, the workspace
permission boundary, automatic review and the unelevated Windows sandbox. The
probe verified MCP, the local proof file and provider usage using the saved
configuration. This verifies that enrollment path; it does not certify every
client, a production deployment, or the complete assignment lifecycle.

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

Assignment prompts ask agents to read `get_inbox`, use relevant thread context,
and acknowledge only handled items through their returned inbox IDs in
`ack_ids`, including answers used when recovering work. Unread, unhandled and
new items remain untouched; the worker never acknowledges the inbox itself.
This is explicit model guidance, not a guarantee of every client's compliance.

Save `.ehgi-handoff.json` before the final MCP `done` or `blocked` transition,
then end promptly after MCP confirms it. A running client gets one fixed
30-second finalization period after the hub acknowledges normal task completion
or its own blocked transition, allowing the handoff and final usage to settle.
Repeated heartbeats cannot extend it. Operator Stop, revoked authorization,
stale fences and budget limits still cancel execution immediately when observed.

The worker renews fenced leases, persists bounded recovery checkpoints and
provider usage, and reports blockers. Independent workers can run concurrently.
An independent monotonic watchdog requests cancellation ten seconds before the
last acknowledged execution lease expires, measured from the request's start.
Older hubs default to a 90-second lease; longer advertised leases remain capped
at that duration. Slow usage delivery or checkpoints cannot renew authority,
and a late response cannot restore it. Live Git checkpoints run asynchronously
with a bounded deadline so they do not block the watchdog. HTTP 401 or 403 from
worker, usage or activity reporting stops the continuous worker; a later
successful response cannot start another coding session in that process.
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
1, 4 and 15 seconds. Native services restart abnormal exits, with a durable ledger
allowing at most three process-crash recoveries. Stop/pause, revoked access,
approval requests, lock conflicts and unknown failures remain paused across
logins; idle retries make no model calls. After repairing the cause, explicitly
run `startup --reset-recovery --state /absolute/private-worker-state`. This
resets the ledger without starting a worker or granting permissions.

Crash recovery preserves locks interrupted during client execution: orphaned CLI
descendants cannot safely be assumed dead. Only idle locks with matching identity
and an OS-confirmed absent PID can be reclaimed. Live/reused/inaccessible PIDs,
legacy locks and abandoned acquisition guards remain for inspection.

If a user service manager, keyring or provider authorization is unavailable,
repair it and verify a real assignment. This source includes generation,
escaping, real failed-process recovery and lock tests; it does not claim native startup acceptance on
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

Workers automatically check local housekeeping at idle and acknowledged-job
boundaries, once per minute in rotating batches of ten. The hub verifies the
exact job/fence and terminal task state before and after fetching the base.
Active leases/workspaces, uncertain receipts, replaced fences and incomplete
acceptance remain ineligible. The existing worker lock stays held throughout
cleanup. Local Git checks still preserve dirty, ignored, untracked and unmerged
work. No extra model calls are made, and remote refs and archived handoffs remain.
At most 100 receipts remain actionable. Replaced executions, absent branches and
overflow are recorded in `housekeeping-retained.jsonl`, with its count and name
saved in worker state. Their worktrees and source remain intact for inspection or
explicit cleanup. Origin checks repeat before fetch, client execution and cleanup;
a repository change pauses the worker instead of trusting another repository's
merge history.

Local managed worktrees can also be cleaned explicitly:

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

Usage comes only from provider-reported counters. Codex samples its exact local
session checkpoint every five seconds while running, with bounded asynchronous
reads and one final sample after exit. One normalizer reconciles these counts
with stdout into cumulative totals for a fresh billing invocation, so the final
report does not charge interim tokens again. A successful fresh run can still
use final stdout when no checkpoint becomes available. Other adapters report
the structured usage their clients emit, often at turn completion.

Readers check the exact session and workspace, file identity, append-only
content, counter consistency and deadlines. Explicit native resume subtracts a
pre-launch baseline and pauses on ambiguous accounting. The worker interleaves
usage delivery with budget, Stop and lease checks; a growing outbox cannot defer
those checks indefinitely. After the child exits, final delivery has a separate
five-second bound and keeps unacknowledged reports and stable IDs for retry.
Reporting failures never justify repeating completed coding work.

Unrecoverable or ambiguous usage persistently pauses further paid work in the
local `usageAttention` record. Restarting, resetting startup recovery or
re-enrolling does not clear it. An operator must reconcile the retained session
before clearing that record. Provider checkpoint delay, polling and delivery
latency still permit overshoot; this is not a strict spending ceiling. Passive
sampling adds no model calls, but more reports create additional hub requests.

Supervisor `--phase implementation|review|coordination` is optional; use it only
when the phase is known. Worker assignments supply their own phase.

The native trials used two Codex 0.153.4 clients with the scoped permissions above.
The later live-meter correction passed fixture tests and replayed all eleven
retained sessions' counters exactly; actual live disk-flush timing and native
explicit-resume acceptance remain to be tested. At the last provider probe,
Claude Code 2.1.139 was logged out and Gemini CLI 0.58.0 had no configured
authentication method.
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
