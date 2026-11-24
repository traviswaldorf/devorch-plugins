/**
 * DevOrch companion mod: pure supervision logic for the `$` adapter (DEV-56, design-L0 D3-D8, D14-D18).
 *
 * Like `core.ts`, this file has no dependency on the Claude Code mod API: it is plain functions over plain data, so
 * `node --test` covers every decision `register.ts` makes. `register.ts` only performs host calls (spawn, timers,
 * `$.command.run`, the status line) and asks these functions what to do. Any branch on data that `register.ts` would
 * need belongs here, with a test.
 *
 * Erasable TypeScript only (no enums, no parameter properties) so Node runs it without a build step.
 */

import {
  EXIT, MAX_RESTARTS, SETTLE_MS, afterChildExit, answerArgv, bandText, compareVersions, isOwnLease, npmUpgrade, positionOf,
  type LadderState, type PlatformEventEnvelope, type Rung,
} from './core.ts'

// ---- the CLI's argv language (R12: the one knowledge coupling between mod and CLI) --------------------------

/**
 * Every option the mod passes to each CLI command it runs. Frozen: the same list is asserted by
 * `CompanionArgvContractTests` in DevOrchestrator.Cli.Tests against the Cocona command definitions, so a renamed or
 * removed option fails a test on either side instead of turning every spawn into a usage error.
 */
export const CLI_OPTIONS = {
  'run watch': ['--since', '--base-url'],
  'run wait': ['--since', '--seconds', '--base-url'],
  'blocker answer': ['--stdin', '--json', '--base-url'],
  version: ['--json'],
  'config get': ['--json', '--settings-from', '--plugin-option'],
  // Not built by the mod: the plugin's .mcp.json runs it (checked by a test against that file).
  'mcp serve': ['--plugin-option'],
} as const satisfies Record<string, readonly string[]>

export type CliCommand = keyof typeof CLI_OPTIONS

/** Rung-3 long-poll length in seconds by default: the server's park limit (the CLI accepts 0-25). */
export const WAIT_SECONDS = 25

/** `devorch run watch <runId> --base-url <url> [--since <token>]`: the long-lived child (rungs 1-2, D15). */
export function watchArgv(exe: string, runId: string, baseUrl: string, since: string | null): string[] {
  assertRunId(runId)
  return [exe, 'run', 'watch', runId, '--base-url', baseUrl, ...(since ? ['--since', since] : [])]
}

/** `devorch run wait <runId> --seconds <n> --base-url <url> [--since <token>]`: one rung-3 long-poll (D5). `seconds`
 * is the `longPollSeconds` setting, clamped again here so a bad value can never reach argv. */
export function waitArgv(exe: string, runId: string, baseUrl: string, since: string | null, seconds: number = WAIT_SECONDS): string[] {
  assertRunId(runId)
  const s = clampInt(seconds, LONG_POLL_RANGE[0], LONG_POLL_RANGE[1], WAIT_SECONDS)
  return [exe, 'run', 'wait', runId, '--seconds', String(s), '--base-url', baseUrl, ...(since ? ['--since', since] : [])]
}

/** How long the mod lets one `run wait` process live: its park time plus 10 s. */
export function pollTimeoutMs(longPollSeconds: number): number {
  return (clampInt(longPollSeconds, LONG_POLL_RANGE[0], LONG_POLL_RANGE[1], WAIT_SECONDS) + 10) * 1_000
}

/** Append the run's base URL (D14). */
export function withBaseUrl(argv: readonly string[], baseUrl: string): string[] {
  return [...argv, '--base-url', baseUrl]
}

/**
 * `devorch blocker answer <slug> <ref> --stdin --json --base-url <url>`: the answer goes on the child's stdin, never in
 * argv. Replaces design-L0's temp file: `$.fs` has no delete, so a temp file would leave the answer on disk. The
 * slug and ref are validated by `core.answerArgv` (no leading '-', so neither can be read as an option).
 */
export function answerStdinArgv(exe: string, slug: string, blockerRef: string, baseUrl: string): string[] {
  if (!isBaseUrl(baseUrl)) throw new Error('invalid base URL')
  const validated = answerArgv(exe, slug, blockerRef, 'stdin')
  return [...validated.slice(0, 5), '--stdin', '--json', '--base-url', baseUrl]
}

export function versionArgv(exe: string): string[] {
  return [exe, 'version', '--json']
}

/** The command (`run watch`, `version`, ...) and the options an argv uses, for the contract test. */
export function optionsOf(argv: readonly string[]): { command: string; options: string[] } {
  const words = argv.slice(1)
  const command = words[0] === 'run' || words[0] === 'blocker' || words[0] === 'mcp' || words[0] === 'config' ? `${words[0]} ${words[1]}` : (words[0] ?? '')
  return { command, options: words.filter((w) => w.startsWith('--')) }
}

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new Error('not a run id')
}

const RUN_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export function isRunId(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID.test(value)
}

// ---- exit codes (D5, R12) ------------------------------------------------------------------------------------

/** The exit codes the CLI documents for `run watch` / `run wait` (`core.EXIT` plus 1 for an unexpected failure). */
export const KNOWN_EXITS: readonly number[] = [EXIT.done, 1, EXIT.notFound, EXIT.transport, EXIT.auth]

/**
 * The next rung after the watch child ended (rungs 1-2). Wraps `core.afterChildExit` with the one rule core lacks:
 * an exit code outside the documented set (a Cocona usage error such as 64 or 129) is a bad argv, so it goes
 * straight to rung 4 and never cycles through rungs 2 and 3. A kill (null) counts as an ordinary death.
 */
export function afterWatchExit(state: LadderState, exitCode: number | null): LadderState {
  if (exitCode !== null && !KNOWN_EXITS.includes(exitCode)) return { rung: 4, restarts: state.restarts, reason: `CLI usage error (exit ${exitCode})` }
  return afterChildExit(state, exitCode)
}

/** Delay before respawning the watch child on rung 2: 1 s, 2 s, 4 s. */
export function respawnDelayMs(restarts: number): number {
  return 1_000 * 2 ** Math.max(0, Math.min(restarts, MAX_RESTARTS) - 1)
}

/** Rung-3 backoff after a failed poll (exit 75 or 1): 5 s, 10 s, then 30 s. */
export const POLL_BACKOFF_MS = [5_000, 10_000, 30_000] as const

export type PollOutcome =
  | { kind: 'line'; delayMs: 0; failures: 0 }
  | { kind: 'retry'; delayMs: number; failures: number }
  | { kind: 'offline'; reason: string }
  | { kind: 'done' }

/**
 * What a rung-3 poller does after one `run wait` returned. Exit 0 prints a line (handled by the caller; poll again at
 * once, the CLI itself parks 25 s); 75 or 1 backs off; 77 or 66 go to rung 4; anything else is a usage error -> rung 4.
 * Polls are strictly sequential: the next starts only after this one returned (no hot loop).
 */
export function afterPoll(exitCode: number, failures: number): PollOutcome {
  if (exitCode === EXIT.done) return { kind: 'line', delayMs: 0, failures: 0 }
  if (exitCode === EXIT.transport || exitCode === 1) {
    const delayMs = POLL_BACKOFF_MS[Math.min(failures, POLL_BACKOFF_MS.length - 1)] as number
    return { kind: 'retry', delayMs, failures: failures + 1 }
  }
  if (exitCode === EXIT.auth) return { kind: 'offline', reason: 'devorch is not signed in (exit 77)' }
  if (exitCode === EXIT.notFound) return { kind: 'offline', reason: 'run not found or server too old (exit 66)' }
  return { kind: 'offline', reason: `CLI usage error (exit ${exitCode})` }
}

// ---- time heal and retry (D4) ---------------------------------------------------------------------------------

/** A watch child that stays up this long heals the ladder (`core.afterHealthyChild`); rungs 3 and 4 retry this often. */
export const HEAL_MS = 10 * 60_000

export type LadderTimer = { kind: 'heal'; afterMs: number } | { kind: 'retry-watch'; afterMs: number } | { kind: 'retry-handshake'; afterMs: number } | null

/** The timer the supervisor arms on entering a rung. */
export function ladderTimer(rung: Rung): LadderTimer {
  if (rung === 1 || rung === 2) return { kind: 'heal', afterMs: HEAL_MS }
  if (rung === 3) return { kind: 'retry-watch', afterMs: HEAL_MS }
  return { kind: 'retry-handshake', afterMs: HEAL_MS }
}

// ---- pending wake expiry (D3) ---------------------------------------------------------------------------------

/** A submitted wake not claimed within this window is treated as lost. */
export const WAKE_EXPIRY_MS = 120_000

export interface WakeHealth {
  /** Unclaimed wakes in a row for this run. */
  misses: number
  /** The wake mechanism is broken: `healthy` is false until a wake is claimed again. */
  wakeBroken: boolean
}

/**
 * A pending wake expired with no claim. The first miss clears the flag and asks for one re-evaluation; the second
 * in a row marks the wake mechanism broken (`healthy: false`), so the skill's own `ScheduleWakeup` takes over.
 */
export function afterWakeExpired(h: WakeHealth): WakeHealth & { reevaluate: boolean; toast: string } {
  const misses = h.misses + 1
  if (misses >= 2) return { misses, wakeBroken: true, reevaluate: false, toast: 'DevOrch: wake not claimed twice; the skill keeps its own wakeup' }
  return { misses, wakeBroken: h.wakeBroken, reevaluate: true, toast: 'DevOrch: wake not claimed; re-checking the run' }
}

/** A claim (the lease turned held, the run moved on, or the woken main-loop turn started) resets the miss count and
 * heals the wake mechanism. An expiry therefore only ever fires when no main-loop turn started since the submit. */
export function afterWakeClaimed(_h: WakeHealth): WakeHealth {
  return { misses: 0, wakeBroken: false }
}

/**
 * Whether a `turn.start` consumes the pending wake (C3, G-18): only a main-loop turn (`agentId` undefined) does, because
 * that is the woken step skill (or the person's own prompt, X5: the queued wake still runs once and the same-token
 * guard stops a re-submit). A subagent turn (a worker, an Explore) never does.
 */
export function clearsPendingOnTurnStart(agentId: string | undefined, pendingWake: boolean): boolean {
  return pendingWake && agentId === undefined
}

// ---- the session's own claim and the same-token guard (DEV-113 C1-C3, X1, DEC-1, DEC-4) ---------------------------

/**
 * Per watched run: which instruction the session's step skill claimed and has not handed back, and the position token
 * a wake must not fire for again. `anchorPending`: the claim arrived before the leased CONTINUE it produced, so the next
 * own-lease line is adopted as `submittedForToken` (the session is already driving that position; waking it would be
 * one idle turn per instruction). In memory only: a mod reload loses it and the wake falls back to no-wake (X6, AC-10).
 */
export interface ClaimState {
  claimedInstructionId: string | null
  submittedForToken: string | null
  anchorPending: boolean
}

export const NO_CLAIM: ClaimState = { claimedInstructionId: null, submittedForToken: null, anchorPending: false }

/** An instruction id is a GUID, like a run id (the only shapes the claim actions accept). */
export function isInstructionId(value: unknown): value is string {
  return isRunId(value)
}

/**
 * `devorch_companion claimed {runId, instructionId}`: the skill fetched a CONTINUE for `instructionId` and holds its
 * lease. When the latest position is already that leased CONTINUE, its token is anchored at once; otherwise the next
 * own-lease line is (`anchorPending`).
 */
export function afterClaimed(s: ClaimState, instructionId: string, latest: PlatformEventEnvelope | null): ClaimState {
  const id = instructionId.toLowerCase()
  const p = latest ? positionOf(latest) : null
  if (p && isOwnLease(p, id)) return { claimedInstructionId: id, submittedForToken: p.position, anchorPending: false }
  return { claimedInstructionId: id, submittedForToken: s.submittedForToken, anchorPending: true }
}

/** `devorch_companion handback {runId, instructionId}`: the result was applied. A hand-back for another instruction than
 * the claimed one (a stale call) leaves the newer claim alone. */
export function afterHandback(s: ClaimState, instructionId: string): ClaimState {
  if (s.claimedInstructionId !== null && s.claimedInstructionId !== instructionId.toLowerCase()) return s
  return { ...s, claimedInstructionId: null, anchorPending: false }
}

/** A wake was submitted for `token`: never submit again for that same unchanged token. */
export function afterWakeSubmitted(s: ClaimState, token: string | null): ClaimState {
  return { ...s, submittedForToken: token, anchorPending: false }
}

/**
 * A new run.position line (X1): a pending anchor adopts the session's own leased CONTINUE; an unleased CONTINUE for
 * the claimed instruction (the fetch's position not seen yet) keeps the anchor pending; anything else drops it. Then
 * `submittedForToken` survives only while the token is unchanged, so T1 -> T2 (blocker) -> T1 wakes again (G-16).
 */
export function afterPositionLine(s: ClaimState, envelope: PlatformEventEnvelope): ClaimState {
  const p = positionOf(envelope)
  if (!p) return s
  if (s.anchorPending) {
    if (isOwnLease(p, s.claimedInstructionId)) return { ...s, submittedForToken: p.position, anchorPending: false }
    const sameInstruction = p.control === 'CONTINUE' && !p.leaseHeld && p.instructionId !== null
      && p.instructionId.toLowerCase() === s.claimedInstructionId
    if (sameInstruction) return { ...s, submittedForToken: null }
    return { ...s, submittedForToken: null, anchorPending: false }
  }
  return s.submittedForToken === p.position ? s : { ...s, submittedForToken: null }
}

// ---- position-token dedupe (D15) ------------------------------------------------------------------------------

/** The envelope's position token, or null when it is not a run.position. */
export function tokenOf(envelope: PlatformEventEnvelope): string | null {
  return positionOf(envelope)?.position ?? null
}

/**
 * Whether to dispatch an envelope: a `run.position` whose token equals the last one dispatched is a repeat (a respawn
 * prints the current position first; `run wait` prints the current one at timeout) and is dropped. Other envelope
 * types pass (the dispatcher dedupes them by id).
 */
export function dedupe(lastToken: string | null, envelope: PlatformEventEnvelope): { dispatch: boolean; lastToken: string | null } {
  const token = tokenOf(envelope)
  if (token === null) return { dispatch: true, lastToken }
  if (token === lastToken) return { dispatch: false, lastToken }
  return { dispatch: true, lastToken: token }
}

// ---- terminals the session already saw (D17) ------------------------------------------------------------------

const TERMINAL = new Set(['DONE', 'ESCALATE', 'ABORT'])

export function isTerminal(envelope: PlatformEventEnvelope | null): boolean {
  const p = envelope ? positionOf(envelope) : null
  return p !== null && TERMINAL.has(p.control)
}

/**
 * A terminal envelope that arrives while a main-loop turn runs, or within `SETTLE_MS` after one ended, was read by the
 * session in its own turn: unwatch, toast, no wake. Only a terminal arriving on an idle session wakes.
 * `ESCALATE` never wakes (core's `decideWake` does not wake on it either); it only unwatches.
 */
export function terminalAction(envelope: PlatformEventEnvelope, turnRunning: boolean, idleForMs: number | null): 'none' | 'seen' | 'wake' {
  if (!isTerminal(envelope)) return 'none'
  if (turnRunning || (idleForMs !== null && idleForMs < SETTLE_MS)) return 'seen'
  return positionOf(envelope)?.control === 'ESCALATE' ? 'seen' : 'wake'
}

// ---- watch cap (D18) ------------------------------------------------------------------------------------------

export const MAX_WATCHED = 8

export function canWatch(watched: readonly string[], runId: string): { ok: true } | { ok: false; reason: string } {
  if (!isRunId(runId)) return { ok: false, reason: 'not a run id' }
  if (watched.some((w) => w.toLowerCase() === runId.toLowerCase())) return { ok: true }
  if (watched.length >= MAX_WATCHED) return { ok: false, reason: 'watch limit' }
  return { ok: true }
}

// ---- hand-back wake on health loss (D16) ----------------------------------------------------------------------

/**
 * When a run turns unhealthy after the tool told the skill `healthy: true`, the skill ended its turn without a
 * `ScheduleWakeup` and nothing would wake it. Submit one `/devorch:step <runId>` so the skill re-reads `status`, sees
 * `healthy: false` and schedules its own wakeup. Not when the Stop-hook host is armed (that host owns the wake), and
 * only once per loss.
 */
export function handBackWake(i: { reportedHealthy: boolean; nowHealthy: boolean; stopHookArmed: boolean; handedBack: boolean }): boolean {
  return i.reportedHealthy && !i.nowHealthy && !i.stopHookArmed && !i.handedBack
}

// ---- exe resolution (D8, D-L0-2, AC-15) -----------------------------------------------------------------------

export interface ExeSources {
  /** `DEVORCH_EXE` from the host environment. */
  env: string | undefined
  /** Plugin `userConfig.devorchExe`. */
  userConfig: unknown
  /** `PATH` from the host environment. */
  path: string | undefined
  /** `PATHEXT` from the host environment (Windows; absent elsewhere). */
  pathext: string | undefined
  /** The engine runs on Windows (`$.session.info().platform`): `;` separates PATH entries and PATHEXT applies. */
  windows: boolean
}

export type ResolvedExe =
  | { exe: string; source: 'env' | 'userConfig' | 'path' }
  | { exe: null; reason: string }

/** The not-found reason: the install command, and the option that points the mod at a CLI somewhere else. */
export const CLI_NOT_FOUND =
  "devorch CLI not found on PATH: install it with `npm i -g dev-orchestrator-cli`, or set the plugin's devorchExe option (or DEVORCH_EXE) to its full path"

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/** An absolute path on either platform: `/x`, `C:\x`, `C:/x` or a UNC `\\host\share`. */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')
}

function joinPath(dir: string, name: string, windows: boolean): string {
  return /[\\/]$/.test(dir) ? dir + name : dir + (windows ? '\\' : '/') + name
}

/**
 * The files a PATH lookup of `devorch` tries, in order. Per PATH entry: on Windows the extensions the CLI ships as
 * (`.exe`, `.cmd`) in PATHEXT's order, skipping one PATHEXT leaves out; then the bare name. Relative or empty entries
 * are skipped, so every candidate is absolute. Mirrors `Launcher.WhichClaude` (.exe, .cmd, bare).
 */
export function pathCandidates(s: Pick<ExeSources, 'path' | 'pathext' | 'windows'>): string[] {
  const dirs = (s.path ?? '')
    .split(s.windows ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d.length > 0 && isAbsolutePath(d))
  const exts = s.windows
    ? (nonEmpty(s.pathext) ? s.pathext : DEFAULT_PATHEXT).split(';').map((e) => e.trim().toLowerCase()).filter((e) => e === '.exe' || e === '.cmd')
    : []
  const names = [...new Set(exts)].map((e) => `devorch${e}`).concat('devorch')
  const out: string[] = []
  for (const dir of dirs) for (const name of names) out.push(joinPath(dir, name, s.windows))
  return [...new Set(out)]
}

/**
 * The native `devorch.exe` an npm `.cmd` shim would run. The shim starts `node run.js`, and a spawn without a shell
 * cannot start a `.cmd` at all (phase 1 spike: EINVAL, CVE-2024-27980), so the mod runs the platform binary instead:
 * `<prefix>\node_modules\dev-orchestrator-cli\node_modules\@devorch\cli-win32-<arch>\bin\devorch.exe`, or the hoisted
 * `<prefix>\node_modules\@devorch\cli-win32-<arch>\bin\devorch.exe`.
 */
export function exeBehindNpmShim(cmdPath: string): string[] {
  const dir = cmdPath.replace(/[\\/][^\\/]+$/, '')
  const out: string[] = []
  for (const arch of ['x64', 'arm64']) {
    const pkg = `@devorch\\cli-win32-${arch}\\bin\\devorch.exe`
    out.push(`${dir}\\node_modules\\dev-orchestrator-cli\\node_modules\\${pkg}`, `${dir}\\node_modules\\${pkg}`)
  }
  return out
}

/**
 * `DEVORCH_EXE` -> `userConfig.devorchExe` -> a PATH lookup returning an absolute path -> not found. No recorded-path file
 * (D-L0-2): the CLI writes nothing into the plugin folder. A `.cmd` hit resolves to the `devorch.exe` behind the npm
 * shim when it is there, else stays the `.cmd` (the handshake then says whether it runs). `exists` is the host's file
 * check; a rejection reads as absent.
 */
export async function resolveExe(s: ExeSources, exists: (path: string) => Promise<boolean>): Promise<ResolvedExe> {
  if (nonEmpty(s.env)) return { exe: s.env.trim(), source: 'env' }
  if (nonEmpty(s.userConfig)) return { exe: s.userConfig.trim(), source: 'userConfig' }
  const has = (p: string): Promise<boolean> => exists(p).catch(() => false)
  for (const candidate of pathCandidates(s)) {
    if (!(await has(candidate))) continue
    if (s.windows && candidate.toLowerCase().endsWith('.cmd')) {
      for (const exe of exeBehindNpmShim(candidate)) if (await has(exe)) return { exe, source: 'path' }
    }
    return { exe: candidate, source: 'path' }
  }
  return { exe: null, reason: CLI_NOT_FOUND }
}

// ---- base URL (D14) -------------------------------------------------------------------------------------------

/** Only an absolute http(s) URL may reach argv as `--base-url`. */
export function isBaseUrl(value: unknown): value is string {
  if (!nonEmpty(value) || value.startsWith('-')) return false
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

// ---- version drift (D13, D-L0-5, AC-16) -----------------------------------------------------------------------

/**
 * The band suffix when the plugin and the CLI it runs carry different versions (still healthy), in both directions.
 * Plugin older: `devorch plugin install` updates it when this CLI has that command (the `plugin-install` feature);
 * a CLI without it is upgraded first. CLI older: the npm upgrade to the plugin's version. `0.0.0-dev` never nags.
 */
export function updateHint(modVersion: string, cliVersion: string, cliFeatures: readonly string[] = []): string | null {
  if (modVersion.startsWith('0.0.0')) return null
  const order = compareVersions(modVersion, cliVersion)
  if (order < 0) return cliFeatures.includes('plugin-install') ? 'update: devorch plugin install' : 'update: npm i -g dev-orchestrator-cli'
  if (order > 0) return `update: ${npmUpgrade(modVersion)}`
  return null
}

// ---- health (D6) ----------------------------------------------------------------------------------------------

export interface HealthInputs {
  /** `wakeMode` is `poll`: the skill owns the wake, so the mod never reports itself healthy (an older skill copy that
   * branches on `healthy` then keeps its own wakeup). */
  pollMode?: boolean
  cliOk: boolean
  cliReason: string
  stopHookArmed: boolean
  wakeBroken: boolean
  /** The asked run's rung, or null for the overall answer. */
  rung: Rung | null
}

/** healthy = handshake ok AND no Stop-hook host AND wake not broken AND (for a run) rung < 4. Any false hands the
 * wake to the skill's `ScheduleWakeup`. */
export function health(i: HealthInputs): { healthy: boolean; reason?: string } {
  if (!i.cliOk) return { healthy: false, reason: i.cliReason }
  if (i.stopHookArmed) return { healthy: false, reason: 'Stop-hook host armed' }
  if (i.wakeBroken) return { healthy: false, reason: 'wake mechanism broken' }
  if (i.rung === 4) return { healthy: false, reason: 'run offline (rung 4)' }
  if (i.pollMode) return { healthy: false, reason: 'wakeMode poll: the skill owns the wake' }
  return { healthy: true }
}

// ---- wake modes: who wakes an interactive run, and the settings behind it --------------------------------------

/**
 * `auto` (default): the companion wakes the session while it is healthy, else the skill polls with `/loop` and
 * `ScheduleWakeup`. `push`: the companion only; when it is unhealthy the skill reports that and stops instead of
 * polling. `poll`: never rely on the companion's wake (the mod submits none; it still shows the status line).
 */
export const WAKE_MODES = ['auto', 'push', 'poll'] as const
export type WakeMode = (typeof WAKE_MODES)[number]

export const FALLBACK_WAKEUP_DEFAULT = 1800
export const FALLBACK_WAKEUP_RANGE = [60, 3600] as const
export const LONG_POLL_RANGE = [5, WAIT_SECONDS] as const

// ---- settings: the CLI's resolved view (DEV-112 K12) ------------------------------------------------------------

/**
 * The plugin options the mod passes to the CLI as the plugin layer (`--plugin-option name=value`). The CLI owns every
 * precedence rule (defaults < ~/.devorch/settings.json < .devorch/settings.json < .devorch/settings.local.json <
 * plugin options < DEVORCH_* env < flags); the mod never computes one. An empty option is not passed (absent).
 */
export const PLUGIN_OPTIONS = ['apiBase', 'wakeMode', 'fallbackWakeupSeconds', 'longPollSeconds'] as const

/** The settings keys the mod reads from the view, by the name the mod uses. */
export const VIEW_KEYS = {
  apiBase: 'apiBase',
  wakeMode: 'wake.mode',
  fallbackWakeupSeconds: 'wake.fallbackWakeupSeconds',
  longPollSeconds: 'watch.longPollSeconds',
} as const

/** `devorch config get --json --settings-from <dir> [--plugin-option name=value]...`: the one resolve, run at start and
 * after a settings file changes (never per event). `--settings-from`, not `--settings-root`: the CLI walks up from the
 * session cwd to the project root exactly as the plugin's MCP server does from its cwd, so both use one root (R-16). */
export function configGetArgv(exe: string, projectDir: string, options: Record<string, unknown> | undefined): string[] {
  if (!nonEmpty(projectDir) || projectDir.startsWith('-')) throw new Error('invalid project directory')
  const argv = [exe, 'config', 'get', '--json', '--settings-from', projectDir]
  for (const name of PLUGIN_OPTIONS) {
    const v = options?.[name]
    const text = typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v.trim() : ''
    if (text.length > 0 && !text.startsWith('${')) argv.push('--plugin-option', `${name}=${text}`)
  }
  return argv
}

/** The devorch.config.v1 view, as far as the mod reads it (pinned by `config-view.v1.shape.json`). */
export interface ConfigView {
  schema: 'devorch.config.v1'
  root: string | null
  files: { scope: string; path: string; exists: boolean; error: string | null }[]
  values: Record<string, { value: unknown; origin: string }>
  warnings: string[] | null
  errors: { source: string; message: string }[] | null
}

/** Parses `config get --json` stdout; anything else is an error string for the status line. */
export function parseConfigView(stdout: string | null): { ok: true; view: ConfigView } | { ok: false; error: string } {
  if (!stdout) return { ok: false, error: 'devorch config get printed nothing' }
  try {
    const view = JSON.parse(stdout) as ConfigView
    if (view?.schema !== 'devorch.config.v1' || typeof view.values !== 'object' || !Array.isArray(view.files)) {
      return { ok: false, error: 'devorch config get printed something other than devorch.config.v1 (update devorch)' }
    }
    return { ok: true, view }
  } catch {
    return { ok: false, error: 'devorch config get printed something that is not JSON' }
  }
}

export interface Settings {
  /** The resolved API base URL, or null before the first good view. */
  apiBase: string | null
  wakeMode: WakeMode
  /** The skill's safety-net `ScheduleWakeup` under poll, in seconds. */
  fallbackWakeupSeconds: number
  /** Rung-3 `devorch run wait --seconds`. */
  longPollSeconds: number
  /** Where each value came from, as the CLI names it (`.devorch/settings.json`, `env (DEVORCH_WAKE_MODE)`, ...). */
  origins: Record<string, string>
  root: string | null
  /** The settings files the CLI read (watched for changes). */
  files: string[]
  warnings: string[]
  /** File and value errors from the last resolve; non-empty means the last good view is kept. */
  errors: string[]
  /** True once a view without errors has been applied. */
  resolved: boolean
}

/** Before the first resolve: nothing is known yet (the status reports `unresolved`; no watch starts without a base). */
export const UNRESOLVED: Settings = {
  apiBase: null, wakeMode: 'auto', fallbackWakeupSeconds: FALLBACK_WAKEUP_DEFAULT, longPollSeconds: WAIT_SECONDS,
  origins: {}, root: null, files: [], warnings: [], errors: [], resolved: false,
}

/** The view's values as the mod's settings. Values are validated defensively (the CLI already typed them). */
export function settingsFromView(view: ConfigView): Settings {
  const get = (key: string) => view.values[key]
  const origins: Record<string, string> = {}
  for (const [name, key] of Object.entries(VIEW_KEYS)) if (get(key)) origins[name] = get(key)!.origin
  const mode = get(VIEW_KEYS.wakeMode)?.value
  const apiBase = get(VIEW_KEYS.apiBase)?.value
  const num = (key: string, range: readonly [number, number], fallback: number) => clampInt(Number(get(key)?.value), range[0], range[1], fallback)
  const errors = [
    ...view.files.filter((f) => f.error).map((f) => `${f.path}: ${f.error}`),
    ...(view.errors ?? []).map((e) => `${e.source}: ${e.message}`),
  ]
  return {
    apiBase: isBaseUrl(apiBase) ? apiBase.replace(/\/+$/, '') : null,
    wakeMode: (WAKE_MODES as readonly unknown[]).includes(mode) ? (mode as WakeMode) : 'auto',
    fallbackWakeupSeconds: num(VIEW_KEYS.fallbackWakeupSeconds, FALLBACK_WAKEUP_RANGE, FALLBACK_WAKEUP_DEFAULT),
    longPollSeconds: num(VIEW_KEYS.longPollSeconds, LONG_POLL_RANGE, WAIT_SECONDS),
    origins,
    root: view.root ?? null,
    files: view.files.map((f) => f.path).filter(nonEmpty),
    warnings: view.warnings ?? [],
    errors,
    resolved: errors.length === 0,
  }
}

/**
 * The settings after one `config get` (AC-18 / G-32): a clean view replaces everything; a view with a file error, or a
 * failed run, keeps the last good values and only records the error, so a half-typed save never flips the base URL
 * back to a default. With no good view yet, a view with errors is still used for what it resolved.
 */
export function nextSettings(previous: Settings, result: { ok: true; view: ConfigView } | { ok: false; error: string }): Settings {
  if (!result.ok) return { ...previous, errors: [result.error] }
  const next = settingsFromView(result.view)
  if (next.errors.length === 0) return next
  if (previous.resolved) return { ...previous, files: next.files.length ? next.files : previous.files, errors: next.errors }
  return { ...next, resolved: false }
}

/** A short status-line hint for a settings error, or null. */
export function settingsHint(s: Settings): string | null {
  const first = s.errors[0]
  if (!first) return null
  return `settings error: ${first.length > 80 ? first.slice(0, 77) + '...' : first}`
}

/** A cheap change signature of the settings files (mtime and size of each; `-` when missing). Compared every second
 * without spawning anything; a change triggers one debounced `config get`. */
export function settingsSignature(stats: readonly ({ mtimeMs: number; size: number } | null)[]): string {
  return stats.map((s) => (s ? `${s.mtimeMs}:${s.size}` : '-')).join('|')
}

/** Debounce after a detected change before re-resolving (one `config get` per save). */
export const SETTINGS_DEBOUNCE_MS = 500
/** How often the mod compares the settings files' signature. */
export const SETTINGS_POLL_MS = 1_000

export interface WakePolicy {
  mode: WakeMode
  /** `push`: the companion wakes the session (run the step once, no /loop, schedule nothing). `poll`: the skill wakes
   * itself (/loop + ScheduleWakeup). `unavailable`: `push` was asked for but the companion is unhealthy; the skill
   * reports it and stops. */
  effective: 'push' | 'poll' | 'unavailable'
  owner: 'companion' | 'skill' | 'none'
  fallbackWakeupSeconds: number
  reason: string
}

/** The one field the skills branch on: the configured mode resolved against the companion's health right now. */
export function wakePolicy(mode: WakeMode, h: { healthy: boolean; reason?: string }, fallbackWakeupSeconds: number): WakePolicy {
  const base = { mode, fallbackWakeupSeconds }
  if (mode === 'poll') return { ...base, effective: 'poll', owner: 'skill', reason: 'wakeMode poll: /loop + ScheduleWakeup' }
  if (h.healthy) return { ...base, effective: 'push', owner: 'companion', reason: 'the companion is healthy and wakes the session' }
  const why = h.reason ?? 'companion unhealthy'
  if (mode === 'push') return { ...base, effective: 'unavailable', owner: 'none', reason: `wakeMode push, but ${why}` }
  return { ...base, effective: 'poll', owner: 'skill', reason: `companion unhealthy (${why}); the skill polls` }
}

/** Whether the mod itself submits wakes (position-change and hand-back): every mode but `poll`. */
export function modWakes(mode: WakeMode): boolean {
  return mode !== 'poll'
}

function clampInt(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

// ---- the status line (D7) -------------------------------------------------------------------------------------

export interface RunView {
  runId: string
  latest: PlatformEventEnvelope | null
  ladder: LadderState
}

const RUNG_LABELS: Record<Rung, string> = { 1: 'live', 2: 'reconnecting', 3: 'polling', 4: 'offline' }

/**
 * One status line for the session: no runs and one run use core's `bandText`; N runs collapse to counts
 * (`DevOrch: N watched | <worst rung> | blockers: <n>`). Enums, refs and counts only, never blocker text (CC-4).
 */
export function statusLine(runs: readonly RunView[], stopHookArmed: boolean, hint: string | null = null): string {
  const suffix = hint ? ` | ${hint}` : ''
  if (runs.length === 0) return bandText(null, null, { rung: 1, restarts: 0, reason: '' }, stopHookArmed) + suffix
  if (runs.length === 1) {
    const r = runs[0] as RunView
    return bandText(r.runId, r.latest, r.ladder, stopHookArmed) + suffix
  }
  if (stopHookArmed) return 'DevOrch: Stop-hook host armed' + suffix
  const worst = Math.max(...runs.map((r) => r.ladder.rung)) as Rung
  const blockers = runs.reduce((n, r) => n + (r.latest ? (positionOf(r.latest)?.openBlockers.length ?? 0) : 0), 0)
  return `DevOrch: ${runs.length} watched | ${RUNG_LABELS[worst]} | blockers: ${blockers}${suffix}`
}

/** The per-run row of the tool's `status` (enums, ids and refs only), with the session's claim (C1). */
export function runStatus(r: RunView & { baseUrl: string; pendingWake: boolean; claim?: ClaimState }): Record<string, unknown> {
  const p = r.latest ? positionOf(r.latest) : null
  const claim = r.claim ?? NO_CLAIM
  return {
    runId: r.runId,
    baseUrl: r.baseUrl,
    rung: r.ladder.rung,
    ladderReason: r.ladder.reason,
    control: p?.control ?? null,
    reasonCode: p?.reasonCode ?? null,
    leaseHeld: p?.leaseHeld ?? false,
    openBlockers: (p?.openBlockers ?? []).map((b) => ({ ref: b.ref, kind: b.kind })),
    pendingWake: r.pendingWake,
    instructionId: p?.instructionId ?? null,
    claimedInstructionId: claim.claimedInstructionId,
    submittedForToken: claim.submittedForToken,
  }
}

// ---- the watched set kept in $.state (D10) ------------------------------------------------------------------

export interface WatchEntry {
  runId: string
  baseUrl: string
  lastToken?: string
  addedAt: number
}

/** Validate a watched set read back from `$.state`: drop malformed entries, keep the first of any duplicate, cap. */
export function restoreWatched(value: unknown): WatchEntry[] {
  const runs = (value as { runs?: unknown } | null | undefined)?.runs
  if (!Array.isArray(runs)) return []
  const out: WatchEntry[] = []
  for (const r of runs as Partial<WatchEntry>[]) {
    if (!r || !isRunId(r.runId) || !isBaseUrl(r.baseUrl) || out.some((o) => o.runId === (r.runId as string).toLowerCase())) continue
    out.push({ runId: r.runId.toLowerCase(), baseUrl: r.baseUrl, addedAt: typeof r.addedAt === 'number' ? r.addedAt : 0, ...(typeof r.lastToken === 'string' ? { lastToken: r.lastToken } : {}) })
    if (out.length >= MAX_WATCHED) break
  }
  return out
}

// ---- the measurement log (D19) --------------------------------------------------------------------------------

export const LOG_MAX_BYTES = 1024 * 1024

/** One log line: ids and timings only, never envelope data or answer text. */
export function logLine(t: number, runId: string, event: string, extra: { token?: string | null; rung?: Rung; exitCode?: number | null; why?: string } = {}): string {
  const row: Record<string, unknown> = { t, runId, event }
  if (extra.token) row.token = extra.token
  if (extra.why) row.why = extra.why
  if (extra.rung !== undefined) row.rung = extra.rung
  if (extra.exitCode !== undefined) row.exitCode = extra.exitCode
  return JSON.stringify(row)
}

// ---- slash-command arguments ----------------------------------------------------------------------------------

/** `/devorch-watch [runId] [baseUrl]`. */
export function parseWatchArgs(args: string): { list: true } | { list: false; runId: string; baseUrl: string | null } | { error: string } {
  const words = args.trim().split(/\s+/).filter((w) => w.length > 0)
  if (words.length === 0) return { list: true }
  const [runId, baseUrl] = words
  if (!isRunId(runId)) return { error: 'usage: /devorch-watch [runId] [baseUrl]' }
  if (baseUrl !== undefined && !isBaseUrl(baseUrl)) return { error: 'baseUrl must be an http(s) URL' }
  return { list: false, runId: runId.toLowerCase(), baseUrl: baseUrl ?? null }
}

/** `/devorch-unwatch <runId|all>`. */
export function parseUnwatchArgs(args: string): { all: true } | { all: false; runId: string } | { error: string } {
  const word = args.trim()
  if (word === 'all') return { all: true }
  if (isRunId(word)) return { all: false, runId: word.toLowerCase() }
  return { error: 'usage: /devorch-unwatch <runId|all>' }
}
