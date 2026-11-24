---
name: sdlc-drive
argument-hint: "<integrationExternalId | issueKey | --run <runId>> [--headless | --interactive] [--integration <id>]"
description: The Claude-side in-session entry + demo wedge for the Sequential Autopilot - discover an assigned issue, claim it, verify the subscription, start an SDLC run, then drive it to DONE either Interactive (default, live in-session turns) or Headless (--headless, devorch run supervise, backgrounded). TRIGGERS - sdlc drive, claim and run my issue, claim my assigned issue, drive my ticket, autopilot my issue, run my assigned issue. USE WHEN - the user wants to claim an assigned tracker issue from Claude Code and have the autopilot take it research->qa to DONE, watched live; or to launch/host a Sequential Autopilot run.
allowed-tools: mcp__plugin_devorch_api__list_assigned_issues, mcp__plugin_devorch_api__next_assigned_issue, mcp__plugin_devorch_api__claim_issue, mcp__plugin_devorch_api__start_sdlc_for_issue, mcp__plugin_devorch_api__whoami, mcp__plugin_devorch_api__get_next_instruction, mcp__plugin_devorch_api__apply_instruction_result, mcp__plugin_devorch_api__get_run_position, mcp__devorch__companion, Bash(devorch run *), Bash(*devorch.exe run *), Bash(*/devorch run *)
---

# SDLC Drive

The **in-session entry point + demo wedge** for the Sequential Autopilot: from inside Claude Code the
user says *"claim and run my assigned issue"* and this skill discovers an assigned tracker issue,
claims it race-safely, verifies the subscription, opens an SDLC run, and then **drives that run to a
terminal state** in one of two run modes.

This skill **does NOT implement the loop.** Both run modes wrap the **same `step_once` primitive**:

- **Interactive** (default, the headline demo) — `/devorch:step` runs **inside this
  session**, woken by the companion mod the moment the run can move (push), or under `/loop` when the mod can't
  (poll); each step's work happens in a subagent, and you steer between steps.
- **Headless** (opt-in with `--headless`, the proven spine) — the loop runs **detached** in
  `devorch run supervise` (fresh `claude -p` per step, `ANTHROPIC_API_KEY`-strip → guaranteed
  subscription billing); you watch via the **portal**.

On a terminal `control` the skill **NOTIFIES** (PushNotification) — it does **not** self-heal. That is
the explicit design boundary: the backend program counter owns advancement; this skill claims, starts,
launches/hosts, and reports.

## Tools and server

Every verb below (`list_assigned_issues`, `next_assigned_issue`, `claim_issue`, `whoami`, `start_sdlc_for_issue`,
`get_next_instruction`, `apply_instruction_result`, `get_run_position`) is a tool of the **DevOrch MCP server**. This
plugin bundles one (`devorch mcp serve`), so the tools read `mcp__plugin_devorch_api__<verb>`. If that
server is missing, use the same verb from whichever DevOrch MCP server this session has, and keep to one server for
the whole run.

The bundled server, the companion mod's watches and the commands below all target one backend: the `apiBase` the
DevOrch settings files resolve to (default `https://api.devorchestrator.com`; a project's `.devorch/settings.json` or
`.devorch/settings.local.json`, `DEVORCH_API_BASE` or the plugin's `apiBase` option can change it). Run
`<devorch> config get apiBase --show-origin` to see it and where it came from. Call that URL `<apiBase>` below.

**Who acted.** The bundled server's tools are recorded as the agent's actions on their own. When you run a `devorch`
command yourself from Bash, add `--actor ai` so it is recorded the same way (`devorch run` already declares itself).
A command you hand to the user to run in their own terminal goes without the flag: that one is theirs.

**If a tool call fails with 401 / "Run `devorch login` first"**, the CLI has no session for `<apiBase>`. Tell the user
to run `devorch login --oauth --base-url <apiBase>` in a terminal (it opens a browser) and then reconnect the server
with `/mcp`; don't try to log in for them.

## Protocol

**Resuming an existing run:** if the argument is a run id (a GUID passed as `--run <runId>`), skip steps 1-4 and
go straight to RUN with it.

### 1. DISCOVER — find an assigned issue (Read band, always available)

You need the **integration's externalId** (`{id}` below) — the issue-tracking integration whose agent
account holds the assigned issues. Take it from the user/args, or list the user's integrations first.

- **`list_assigned_issues(id)`** → `[{issue_key, title, status, claim_state, dispatch_external_id?}]`
  (`claim_state` ∈ `unclaimed | queued | leased | running | completed | failed | cancelled`).
- **`next_assigned_issue(id)`** → the first still-`unclaimed` issue, or `null` when nothing is claimable.

Pick the target issue (prefer `next_assigned_issue` for the simple "do my next ticket" flow).

### 2. CLAIM — atomically claim it (`pipeline.control`)

**`claim_issue`** with body `{"integration_id": "<integration externalId>", "issue_key": "DEV-103"}` →
`{dispatch_external_id, leased, issue_key}`. The wire is **snake_case**: a camelCase body
(`integrationId`/`issueKey`) is rejected with 400 `issue_key is required`. An issue key does not have to appear in
`list_assigned_issues` to be claimed.

- `leased: true` → **you won the claim**; carry `dispatch_external_id` to START.
- `leased: false` → **someone already claimed it** (race lost — a 200 VALUE, never an error). **Move to
  the next issue** (`next_assigned_issue` again, or the next `unclaimed` row) and re-claim. This is a
  clean loop, not a failure.

### 3. VERIFY SUBSCRIPTION — check the gate, warn (don't block) in v1

Call **`whoami`** and inspect the active org + plan/entitlement. The hard binary **402
`upgrade_required`** gate ships later on the claim/start verbs; **in v1 this skill only
checks and WARNS** — if there is no active subscription/plan, surface a clear warning that the run may
be blocked once that gate lands, then proceed. (SuperAdmin/system bypass; don't hard-stop here.)

### 4. START — open the run (`pipeline.control`)

**`start_sdlc_for_issue({id: dispatch_external_id})`** →
`{workItemSlug, runNumber, runExternalId, issueLink, instruction}`.

- `instruction` is the **inline informational envelope**: prompt-shaped first task with
  **`instructionId: null`** — **informational only**, it does NOT advance the program counter. Use it to
  preview the first step; the driver/host fetches the real instruction via `get_next_instruction`.
- Keep `runExternalId` (the run id every `devorch run` / `get_next_instruction` call needs) and
  `workItemSlug`.

### 5. RUN — branch on mode

**Default = Interactive** unless the user asked for `--headless`.

#### Interactive (default — the headline demo)

The main thread only orchestrates: each instruction's work runs in a `devorch:step-worker` subagent, and the session
is idle between firings so the user can steer. `/devorch:step` handles the terminal `control` notifications (step 6).

**Pick the wake from the companion (DEV-47, DEV-56).** Exactly one thing wakes the session between firings: the
companion mod (push, realtime) or `/loop` with `ScheduleWakeup` (poll, timed). Decide once, from the mod:

1. If the companion tool `mcp__devorch__companion` exists, call it with
   `{action: "watch", runId: <runExternalId>}`; add `baseUrl` only when the run lives on a different server from
   `<apiBase>` (for example a worktree slot). Read **`wake.effective`** from the answer and don't re-derive it from
   `healthy`.
2. Branch on it:

   | `wake.effective` | Start the run with |
   |---|---|
   | `push` | **`/devorch:step <runExternalId>` once, with no `/loop`.** The mod submits the next firing itself whenever the run can move (a blocker answered, a lease freed, the run finished) and hands the wake back if it turns unhealthy. |
   | `poll` | **`/loop /devorch:step <runExternalId>`**, as before: the step skill schedules its own wakeups (`wake.fallbackWakeupSeconds` as the safety net). |
   | `unavailable` | Nothing. `wakeMode` is `push` but the companion is unhealthy: tell the user `wake.reason`, and that `/devorch:step <runExternalId>` resumes the run once it's fixed (or set `wakeMode` to `auto`/`poll`). Stop. |

   **No companion tool:** use `poll`. The one exception is a user who set `wake.mode: push` (in a settings file, the plugin's `wakeMode` option or `DEVORCH_WAKE_MODE`)
   and said so: report that the companion is missing and stop.

The mode is the `wake.mode` setting (`auto` by default: push while the companion is healthy, else poll), resolved by
the CLI from the DevOrch settings files, the plugin's `wakeMode` option and `DEVORCH_WAKE_MODE`; see the plugin
README's "Wake modes". Blockers can be answered from the
session with `/devorch-answer <slug> <ref> <answer>` (mod) or `devorch blocker answer <slug> <ref> --text ...`;
headless `devorch run supervise` parks a WAIT on the server and resumes on its own.

> **Billing:** Interactive runs on your already-logged-in subscription — **no key-strip** (you launched
> Claude logged in). **Claude-only** for now.

#### Headless (`--headless` — the proven spine)

Launch the restart-safe supervisor **backgrounded** so this session stays responsive:

```
<devorch> run supervise <runExternalId> --base-url <apiBase>
```

`<devorch>` is the CLI the companion recorded, in this order:

1. the `cli.path` the companion tool reports (`{action: "status"}`): `DEVORCH_EXE`, the plugin's `devorchExe` option or
   the absolute path its PATH lookup found;
2. in the DevOrch workspace, `${CLAUDE_PROJECT_DIR}/tools/devorch/devorch.exe` when it exists (a local build of
   `main`; rebuild it from `app/backend/src/DevOrchestrator.Cli` if it is stale);
3. `devorch` on PATH.

If the chosen binary answers `Error: 'run' is not a command.`, it predates the `run` commands: say so and ask the user
to update the CLI (`npm i -g dev-orchestrator-cli@latest` or `dotnet tool update -g dev-orchestrator-cli`). Don't fall
back to another binary silently.

Run it with the **Bash tool's `run_in_background: true`**. Then surface the **portal URL** so the user can watch the
run live (stages / gates / linked sessions): `/app/work-items/{workItemSlug}` on the web app that pairs with
`<apiBase>` (hosted: `https://app.devorchestrator.com/app/work-items/{workItemSlug}`; a local backend on port 87NN
pairs with `http://localhost:88NN`). A specific run is `/app/work-items/{workItemSlug}/runs/{runNumber}`. Poll status
with `get_run_position` or the portal; do not block this session on it.

> **Permission gate:** the Headless child spawns `claude -p`, so the actual launch is gated on the
> `Bash(claude *)` permission (and the `devorch run *` permission). If those aren't granted,
> report the exact command for the user to run and stop — do not attempt to bypass the gate.

### 6. NOTIFY on terminal `control` (NOT self-heal)

When the run reaches a terminal `control`, branch and **notify** with a PushNotification — never
auto-fix:

| Terminal `control` | Action |
|---|---|
| `DONE` | PushNotification: run complete; link the card/portal. |
| `ESCALATE` | PushNotification: surfaced blockers/defects + the run digest; a human takes it. |
| `ABORT` | PushNotification: the run was aborted (operator/quota/guard). |

## Operator stop / abort (stop a runaway run)

A back-edge loop or quota-burning run must be stoppable from the operator side:

- **Headless:** `<devorch> run abort <runExternalId>` (the same binary as the supervisor, chosen as above) — reaps
  the tracked headless `claude -p` children for the driver process (best-effort operator stop). Also stop the
  backgrounded `supervise` task.
- **End the run on the server:** `<devorch> run cancel <runExternalId> [--reason <text>]` sets the run to
  `Cancelled`, releases its instruction lease, and makes the driver's next fetch answer `ABORT` with the reason. It
  reaps no local children, so pair it with `run abort` for a headless run.
- **Interactive (in-session control):** unwatch the run with `/devorch-unwatch <runId>` so the companion submits no
  further firing (push), and under `/loop` (poll) tell the session to stop the loop; it calls
  `ScheduleWakeup(stop: true)`.

## Anti-patterns

- **Self-healing on a terminal control** — DONE/ESCALATE/ABORT → **notify**, never auto-retry/auto-fix.
  The backend PC owns advancement and back-edges.
- **Advancing the PC by hand in Headless** — the `devorch run` driver owns `get_next_instruction` /
  `apply_instruction_result` there; don't call them yourself for a Headless run.
- **Treating `leased:false` as an error** — it's the race-lost VALUE; move to the next issue.
- **Trusting the START `instruction` as binding** — its `instructionId` is null (informational only);
  the real first instruction comes from `get_next_instruction`.
- **Hard-blocking on the subscription in v1** — check + warn; the binary 402 gate comes later.
- **Doing a step's work in this session** — Interactive routes every step through `/devorch:step`'s worker.
- **Mixing backends** — the MCP server, the watch and `devorch run` must all point at `<apiBase>`.
