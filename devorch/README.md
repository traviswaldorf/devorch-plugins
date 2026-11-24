# The devorch plugin (DEV-47 C6, DEV-56, DEV-122)

A self-contained Claude Code plugin for driving DevOrch runs from any repository. The **devorch plugin** is the
package (`devorch@devorch-cli`); the **companion** is its mod (`hooks/`), which watches runs and wakes the session:

| Piece | Path | What it is |
|---|---|---|
| `/devorch:sdlc-drive` | `skills/sdlc-drive/` | Claim an assigned tracker issue, start an SDLC run, drive it (Interactive or `--headless`). |
| `/devorch:step` | `skills/step/` | Process a run's next instruction and keep going; the mod wakes it between instructions (push), or `/loop` does (poll). |
| `devorch:step-worker` | `agents/step-worker.md` | The subagent that does one instruction's work in a fresh context. |
| MCP server `api` | `.mcp.json` | `devorch mcp serve`: the CLI's stdio MCP server (full profile, no admin band), started from PATH. Tools read `mcp__plugin_devorch_api__<tool>`. |
| The companion mod | `hooks/` | Watches a run with `devorch run watch <runId>`, shows its position and open blockers in a status line, and wakes an idle session with `/devorch:step <runId>` the moment the run can move, so an interactive run no longer polls. |

Everything targets **one backend**: the `apiBase` the DevOrch settings files resolve to (default the hosted API,
`https://api.devorchestrator.com`). The CLI owns every setting (DEV-112): defaults < `~/.devorch/settings.json` <
`.devorch/settings.json` < `.devorch/settings.local.json` < plugin options < `DEVORCH_*` environment < flags. The mod
and the bundled MCP server read that one view (`devorch config get --json`), so `devorch config get apiBase
--show-origin` shows exactly what the plugin uses. A single watch can still name its own base URL. It is separate from
the DevOrch workspace's own `devorch-guard` mod.

## First run (new user)

1. **Install the CLI** (either channel):

   ```bash
   npm i -g dev-orchestrator-cli            # or: dotnet tool install -g dev-orchestrator-cli
   ```

2. **Sign in to the hosted API.** `devorch login` uses the resolved `apiBase` (the hosted API unless a settings file,
   `DEVORCH_API_BASE` or `--base-url` names another); tokens are cached per base URL in `~/.devorch/token.json`, and
   the plugin's MCP server reuses that session:

   ```bash
   devorch login --oauth --base-url https://api.devorchestrator.com
   ```

3. **Install the plugin.** `devorch plugin install` adds the public marketplace and installs `devorch@devorch-cli` in
   Claude Code, or updates both when the plugin is already installed, then prints the next steps (restart Claude Code,
   and the `devorch login` command when you aren't signed in for the resolved `apiBase`). `--scope user|project|local`
   is passed to Claude Code; `--print` only prints the commands; with no `claude` on PATH it prints them and exits 66:

   ```bash
   devorch plugin install
   # the same, by hand:
   claude plugin marketplace add https://github.com/traviswaldorf/devorch-plugins.git
   claude plugin install devorch@devorch-cli
   ```

4. **Start Claude Code** in your repository, check `/mcp` lists `plugin:devorch:api` as connected, then
   run `/devorch:sdlc-drive <integrationExternalId>`.

After upgrading the CLI, update the plugin to the same version with `devorch plugin install` (it runs
`claude plugin marketplace update devorch-cli` and `claude plugin update devorch@devorch-cli`). The status line names the
command whenever the plugin and the CLI versions differ, in either direction.

### No GitHub SSH key: `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`

`devorch plugin install` adds the marketplace by its HTTPS git URL, so it needs no SSH key. A marketplace that a
project enables from its committed settings (`"source": {"source": "github", "repo": "traviswaldorf/devorch-plugins"}`,
see *Enabling the plugin for a team* below) is cloned by Claude Code itself, which prefers SSH for a `github` source.
Without a GitHub SSH key that clone, and every later in-session update, fails. Set this once in your shell profile (or
in the `env` block of your user `~/.claude/settings.json`) so Claude Code clones GitHub sources over HTTPS:

```bash
export CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1          # bash / zsh
setx CLAUDE_CODE_PLUGIN_PREFER_HTTPS 1            # Windows (terminals opened afterwards pick it up)
```

### Upgrading on Windows: close Claude Code sessions first

On Windows a running Claude Code session keeps the plugin's MCP server (`devorch mcp serve`) running, and that holds
`devorch.exe` inside npm's global `node_modules` open. `npm i -g dev-orchestrator-cli` then fails with `EBUSY`. Before
you upgrade the CLI:

1. Close every Claude Code session that has the plugin enabled.
2. `npm i -g dev-orchestrator-cli` (or `dotnet tool update -g dev-orchestrator-cli`).
3. `devorch plugin install` to bring the plugin to the same version, then start Claude Code again.

`devorch plugin install` prints the same reminder in its next steps.

### Enabling the plugin for a team (committed settings)

A repository can offer the plugin to everyone who opens it by committing this to its `.claude/settings.json`. A session
started in a fresh clone (once the folder is trusted) is offered the marketplace and the plugin:

```json
{
  "extraKnownMarketplaces": {
    "devorch-cli": { "source": { "source": "github", "repo": "traviswaldorf/devorch-plugins" } }
  },
  "enabledPlugins": { "devorch@devorch-cli": true }
}
```

Each person still needs the CLI on PATH (`npm i -g dev-orchestrator-cli`), a `devorch login`, and
`CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` when they have no GitHub SSH key.
`DEVORCH_EXE` (or the plugin's `devorchExe` setting) overrides the executable the mod runs; the MCP server always runs
`devorch` from PATH.

**Local (dev) builds.** A plain `dotnet build` of the CLI reports `"build": "dev"` in `devorch version --json`, and the
mod's handshake then checks only the feature tokens (`run-watch`, `run-wait`), not the `0.10.0` version floor. Any
other `build` value, or none (every earlier release), must clear the floor. The build stamps the plugin's
`plugin.json` with the CLI's own version, so a plugin and CLI from the same build show no `update:` hint. A pair built
separately (a dev plugin with a release CLI, or the reverse) can still show it.

## Wake modes

Between instructions an interactive run needs something to wake the session: a worker is running, or the run is
waiting on a human. Two mechanisms, and exactly one owns the wake at a time:

- **push** (realtime): the mod watches the run and submits `/devorch:step <runId>` within seconds of
  it becoming actionable. `sdlc-drive` runs the step skill **once, with no `/loop`**, and the step skill schedules no
  wakeups. After a worker hands back, the step skill goes straight on to the next instruction in the same turn.
- **poll** (timed): `sdlc-drive` runs `/loop /devorch:step <runId>` and the step skill keeps its own
  `ScheduleWakeup`s: `retryAfterSeconds` on a `WAIT`, and a safety-net wakeup while a worker runs.

The companion tool's (`mcp__devorch__companion`) `status` and `watch` answers carry the resolved policy, which is the one field the skills
branch on:

```json
"wake": { "mode": "auto", "effective": "push", "owner": "companion", "fallbackWakeupSeconds": 1800, "reason": "..." }
```

`effective` is `push`, `poll`, or `unavailable` (`wakeMode` is `push` but the companion is unhealthy: the skill reports
`reason` and stops). `status` also returns `config`: each value, its origin as the CLI names it (for example
`.devorch/settings.json` or `env (DEVORCH_WAKE_MODE)`), the settings files read, and any warnings or file errors.

| Settings key | Plugin option | Environment | Default | Values |
|---|---|---|---|---|
| `apiBase` | `apiBase` | `DEVORCH_API_BASE` | `https://api.devorchestrator.com` | The DevOrch server for the MCP server, watches and answers. |
| `wake.mode` | `wakeMode` | `DEVORCH_WAKE_MODE` | `auto` | `auto`: push while the companion is healthy, else poll. `push`: the companion only; unhealthy means report and stop, never poll. `poll`: always `/loop` + `ScheduleWakeup`; the mod still shows the status line (with `wake: poll`) but submits no wakes and reports `healthy: false`. |
| `wake.fallbackWakeupSeconds` | `fallbackWakeupSeconds` | `DEVORCH_FALLBACK_WAKEUP_SECONDS` | `1800` | The safety-net `ScheduleWakeup` under poll while a worker runs, and after a `WAIT` with no `retryAfterSeconds`. 60..3600. |
| `watch.longPollSeconds` | `longPollSeconds` | `DEVORCH_LONG_POLL_SECONDS` | `25` | The mod's rung-3 fallback (`devorch run wait --seconds N`, used only when the live watch keeps failing). 5..25, the server's limit. |

Put a setting in a DevOrch settings file, for example a team default in the committed `.devorch/settings.json`:

```json
{ "$schema": "./devorch-settings.v1.json",
  "apiBase": "http://localhost:8700", "wake": { "mode": "poll" } }
```

For editor completion, write the schema beside the file with `devorch config schema > .devorch/devorch-settings.v1.json`
(it is generated from the CLI's settings catalog, so regenerate it after a CLI update). `$schema` is a relative path
because the schema has no public URL yet.

Commands in the project file's `hooks` and its `env` block run only after you approve them once
(`devorch config approve`). An approval covers the exact content: any edit asks again. Approvals are kept per
repository, so slot 0 and every git worktree of the same repository share them while the file is identical; a worktree
whose project file differs is asked again, and a headless worker there runs no project hooks until someone approves.

or with `devorch config set wake.mode poll --scope project` (`--scope local` for `.devorch/settings.local.json`, this
machine only). The plugin options are left empty by default ("empty = use the DevOrch settings files"); setting one
overrides the files for the plugin only. The mod re-reads the view about a second after a settings file is saved, with
no `/plugin configure` or reload. A settings file that does not parse shows its file and line on the status line, and
the mod keeps the last good values.

## Design notes

- **Which `devorch` runs.** The CLI writes nothing into the plugin folder. The MCP server's `.mcp.json` command is a
  bare `devorch`, which Claude Code's launcher resolves from PATH (on Windows it starts npm's `devorch.cmd` shim too).
  The mod resolves the CLI itself, in this order: `DEVORCH_EXE`, the plugin's `devorchExe` option, then a PATH lookup
  that honours `PATHEXT` (`.exe` and `.cmd`, then the bare name) and returns an absolute path. A spawn without a shell
  cannot start a `.cmd`, so an npm `devorch.cmd` hit maps to the platform `devorch.exe` behind it
  (`node_modules/dev-orchestrator-cli/node_modules/@devorch/cli-win32-<arch>/bin/devorch.exe`). Not found, the status
  line says to `npm i -g dev-orchestrator-cli` or set `devorchExe`. The CLI must be 0.23.0 or later (the first release
  that strips the global `--plugin-option`); an older one fails the handshake with the npm upgrade to the plugin's
  version.
- **The MCP server is `devorch mcp serve`.** Over stdio it resolves its base URL through the DevOrch settings files,
  with the plugin's `apiBase` option passed as the plugin layer (`--plugin-option apiBase=${user_config.apiBase}`). An
  empty or unsubstituted value counts as unset, so an empty option means "use the settings files". The mod reads the
  same resolved view (`devorch config get --json`), so watches and the skills' tools hit one server, and neither
  computes precedence itself.
- **Wake command.** Claude Code names plugin skills `/<plugin>:<skill>`, so the mod always submits `devorch:step`
  (`PLUGIN_STEP_COMMAND` in `hooks/core.ts`). The plugin name, the `skills/step/` folder and that literal are one
  naming unit (a test pins it); there is no bare-name fallback. A rejected wake reads as `healthy: false`, so under
  `auto` the next firing sees `wake.effective: poll` and the skill keeps its own `ScheduleWakeup` (it starts `/loop`
  when it wasn't under one).
- **Tool names.** The skills name `mcp__plugin_devorch_api__*` in `allowed-tools` and refer to verbs by
  their bare name in the body ("the DevOrch MCP server's `get_next_instruction`"), so any DevOrch MCP server with the
  same tools also works. Keep the server key `api`: renaming it renames every tool.
- **Stage work outside the workspace.** The worker follows `execute-instruction` / `evaluate-gate` and the stage skills
  when the session has them (the DevOrch workspace does); elsewhere it runs the server-assembled step prompt
  (`get_step_prompt`). Workspace-only steps (worktrees via `scripts/worktree_manage.py`, `app_run.py`, slot rules) are
  guarded behind "in the DevOrch workspace".
- The worker's result-schema block is a copy of the workspace-rendered rule (`openapi/result-schema-rule.json`);
  refresh it when that rule changes.

## Dogfooding locally (the DevOrch workspace)

The workspace's committed `.devorch/settings.json` sets `apiBase: http://localhost:8700`, so the bundled MCP server,
the watches and the CLI all hit the local backend with the plugin options left empty. Sign in once for that URL:
`devorch login --base-url http://localhost:8700` (password or `--oauth`).

- **Worktree slots.** A slot's backend is on `http://localhost:87NN`. `worktree_manage.py create` writes the slot's
  `apiBase` into the worktree's `.devorch/settings.local.json`, so a session started in the worktree targets its own
  slot. A single watch can still name its own base URL (`/devorch-watch <runId> http://localhost:87NN`).
- **The workspace's own MCP servers** (`devorch-local`, `devorch-local-mcp` in `.mcp.json`) stay for ad-hoc and admin
  use: `devorch-local` runs `mcp serve --allow-control` (the admin band the plugin's server never exposes). The
  shipped skills use the plugin's server.
- The workspace enables the **published** plugin (`devorch@devorch-cli` from the public marketplace) in its committed
  `.claude/settings.json`, so a plain `claude` session runs the last released plugin, not your edits.

### Developing the plugin: `--plugin-dir` shadows the published one

Edit the plugin only here, in `packaging/claude-mod/devorch/`. The public marketplace repo is a generated mirror that
each CLI release overwrites. To run your working copy while the published plugin stays installed and enabled, start
Claude Code with:

```bash
claude --plugin-dir <worktree>/app/backend/packaging/claude-mod/devorch
```

A `--plugin-dir` plugin with the same name (`devorch`) replaces the installed marketplace plugin for that session only:
the skills, agent, MCP server `api` and mod all come from your folder, and nothing installed or enabled changes. Close
the session and a plain `claude` is back on the published plugin, with no uninstall, disable or reinstall.

- The working copy's MCP server still runs `devorch` from PATH (0.23.0 or later). To pair the mod with a CLI you just
  built, set `DEVORCH_EXE` to the local build (`src/DevOrchestrator.Cli/bin/Debug/net10.0/devorch.exe`).
- After editing `hooks/`, run `npm test` (below); `claude plugin validate packaging/claude-mod` checks the manifests.
  Restart the session to load the change.

## Status

| Piece | File | Status |
|---|---|---|
| Envelope parsing, NDJSON framing, generic event hook, wake decision, source ladder, CLI handshake, band text | `hooks/core.ts` | built, tested |
| Supervision decisions: exit-code mapping (unknown -> rung 4), rung-3 backoff, heal/retry timers, pending-wake expiry, position dedupe, hand-back wake, terminal rule, watch cap, exe and base-URL resolution, multi-run status, `healthy`, wake settings (env > option > default) and the wake policy | `hooks/supervision.ts` | built, tested |
| CLI option contract (R12): `test/cli-options.json`, checked by the mod tests and by `CompanionArgvContractTests` (C#) | `test/` | built, tested |
| `register.ts`: the adapter over `$` (process spawn, turn tracking, `$.command.run`, status line, `/devorch-watch`, `/devorch-unwatch`, `/devorch-answer`, tool `companion`, `$.devorch.on` for other plugins) | `hooks/register.ts` | built; **behaviour unverified until the Windows spike** (DEV-56's `spike-tq27.md` in the workspace's sdlc records) and QA |
| `.claude-plugin/plugin.json`, `hooks/hooks.json`, marketplace manifest | `.claude-plugin/`, `../.claude-plugin/` | built |
| Shipping in the npm and NuGet packages; `CLI_PATHS` and `on.push.paths`; `devorch plugin install` (installs or updates from the public marketplace; `--print` only prints); `devorch mcp serve` with the doc-only global `--plugin-option` / `--settings-root` | CLI | built |
| Skills `sdlc-drive`, `step`, agent `step-worker`, MCP server `api` | `skills/`, `agents/`, `.mcp.json` | built; live OAuth against the hosted API unverified |

The spike still decides three things the adapter assumes: that `$.process.spawn` of the native `devorch.exe` shows no
console window on Windows, which event marks the end of a main-loop turn, and that
`$.command.run({command: "devorch:step"})` queues until idle and rejects an unknown command. Every host failure
reads as `healthy: false`, so under `wakeMode: auto` the skills fall back to `ScheduleWakeup` rather than stalling.

## Tests

```bash
cd packaging/claude-mod/devorch
npm test            # node --test test/*.test.ts (Node >= 22.18 runs the TypeScript directly)
```

The hooks use only erasable TypeScript (no enums, no parameter properties) so Node runs them without a build step.

## Contract with the CLI

- `devorch run watch <runId> [--since <token>] [--base-url <url>]`: one `run.position` platform event envelope (v1) per
  line on stdout, per position change, until the run is terminal. Exit 0 terminal, 77 auth, 66 not found, 75 transport;
  any other code is a usage error (rung 4).
- `devorch run wait <runId> --since <token> [--seconds 25] [--base-url <url>]`: exactly one line (rung 3).
- `devorch blocker answer <slug> <ref> --stdin --json [--base-url <url>]`: the answer is piped, never in argv.
- `devorch version --json`: `{version, path, features, hub}`; the mod requires `run-watch` and `run-wait`.
- Lines carry ids, refs and enums only. The mod passes no server string to a prompt or command except the run id it
  already holds.
