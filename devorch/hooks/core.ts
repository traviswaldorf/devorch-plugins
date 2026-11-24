/**
 * DevOrch companion mod: the pure core (DEV-47 C6).
 *
 * Everything here is plain TypeScript with no dependency on the Claude Code mod API (`$`), so it is unit-tested with
 * `node --test` and survives mod API changes. `register.ts` (the thin adapter over `$`, built once the phase 3
 * Windows spike settles rung 3 and the turn-end signal) wires these pieces to processes, timers, commands and the
 * status band.
 *
 * Contract with the CLI: `devorch run watch <runId>` prints one platform event envelope (v1) per line on stdout.
 * Lines carry ids, refs and enums only (CC-4), and this module never forwards any server string to a prompt or a
 * command except the run id it already holds.
 */

// ---- the envelope (the subset the mod reads) ----------------------------------------------------------------

export interface PlatformEventEnvelope {
  id: string
  type: string
  version: number
  occurredAt: string
  org: string
  actor: { kind: string; externalId: string } | null
  subject: { kind: string; externalId: string }
  run: { externalId: string } | null
  data: Record<string, unknown>
}

/** The `data` of a `run.position` envelope (the members the mod uses). */
export interface RunPositionData {
  position: string
  runStatus: string
  control: 'CONTINUE' | 'WAIT' | 'DONE' | 'ESCALATE' | 'ABORT' | string
  kind: string | null
  instructionId: string | null
  openBlockers: { ref: string; kind: string }[]
  reasonCode: string | null
  leaseHeld: boolean
}

export const RUN_POSITION = 'run.position'

/** Parse one line into an envelope, or null for anything that is not one (malformed lines are skipped, never fatal). */
export function parseEnvelope(line: string): PlatformEventEnvelope | null {
  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed.length > 64 * 1024) return null
  try {
    const value = JSON.parse(trimmed) as Partial<PlatformEventEnvelope>
    if (typeof value !== 'object' || value === null) return null
    if (typeof value.id !== 'string' || typeof value.type !== 'string') return null
    if (typeof value.subject !== 'object' || value.subject === null) return null
    if (typeof value.data !== 'object' || value.data === null) return null
    return value as PlatformEventEnvelope
  } catch {
    return null
  }
}

export function positionOf(envelope: PlatformEventEnvelope): RunPositionData | null {
  if (envelope.type !== RUN_POSITION) return null
  const d = envelope.data as Partial<RunPositionData>
  return typeof d.position === 'string' && typeof d.control === 'string' ? (d as RunPositionData) : null
}

// ---- NDJSON framing across stdout chunks ----------------------------------------------------------------------

/** Splits a child's stdout chunks into whole lines; a line split across chunks is joined. */
export class LineSplitter {
  private buffer = ''

  push(chunk: string): string[] {
    this.buffer += chunk
    const parts = this.buffer.split(/\r?\n/)
    this.buffer = parts.pop() ?? ''
    return parts.filter((p) => p.length > 0)
  }

  /** The unterminated tail, when the stream ends. */
  flush(): string[] {
    const tail = this.buffer
    this.buffer = ''
    return tail.length > 0 ? [tail] : []
  }
}

// ---- the generic event hook (AC-5, AC-903) --------------------------------------------------------------------

export type EventHandler = (envelope: PlatformEventEnvelope) => void | Promise<void>
export type EventPredicate = (envelope: PlatformEventEnvelope) => boolean

/**
 * The generic platform event hook: anyone (this mod, another mod through the exported dispatcher) registers a
 * handler for a type (`run.position`), a prefix wildcard (`blocker.*`) or every type (`*`). A throwing handler is
 * reported and never stops the other handlers or the source. Envelopes are deduped by id.
 */
export class EventDispatcher {
  private readonly handlers: { pattern: string; predicate?: EventPredicate; handler: EventHandler }[] = []
  private readonly seen: string[] = []
  private readonly onError: (error: unknown, pattern: string) => void

  // No parameter properties: the file stays erasable TypeScript so `node --test` runs it without a build step.
  constructor(onError: (error: unknown, pattern: string) => void = () => {}) {
    this.onError = onError
  }

  on(pattern: string, handler: EventHandler): () => void
  on(pattern: string, predicate: EventPredicate, handler: EventHandler): () => void
  on(pattern: string, a: EventHandler | EventPredicate, b?: EventHandler): () => void {
    const entry = b ? { pattern, predicate: a as EventPredicate, handler: b } : { pattern, handler: a as EventHandler }
    this.handlers.push(entry)
    return () => {
      const i = this.handlers.indexOf(entry)
      if (i >= 0) this.handlers.splice(i, 1)
    }
  }

  async dispatch(envelope: PlatformEventEnvelope): Promise<number> {
    if (this.seen.includes(envelope.id)) return 0
    this.seen.push(envelope.id)
    if (this.seen.length > 512) this.seen.splice(0, this.seen.length - 512)

    let ran = 0
    for (const { pattern, predicate, handler } of [...this.handlers]) {
      if (!matches(pattern, envelope.type)) continue
      try {
        if (predicate && !predicate(envelope)) continue
        ran += 1
        await handler(envelope)
      } catch (error) {
        this.onError(error, pattern)
      }
    }
    return ran
  }
}

export function matches(pattern: string, type: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith('.*')) return type.startsWith(pattern.slice(0, -1))
  return pattern === type
}

// ---- the source ladder (AC-5, AC-902) -------------------------------------------------------------------------

/**
 * Rung 1: a long-lived `devorch run watch` child. Rung 2: restarting it after it died (bounded). Rung 3: one-shot
 * long-polls (`devorch run wait`; the M3-B fetch alternative is decided by the phase 3 spike). Rung 4: a timer only,
 * reported `healthy: false` so the skill keeps its own wakeup.
 */
export type Rung = 1 | 2 | 3 | 4

export interface LadderState {
  rung: Rung
  restarts: number
  reason: string
}

export const MAX_RESTARTS = 3

/** Exit codes from the CLI (`ExitCodes.cs`). */
export const EXIT = { done: 0, auth: 77, notFound: 66, transport: 75 } as const

/** The next rung after the watch child exited with `exitCode` (null: it was killed or failed to start). */
export function afterChildExit(state: LadderState, exitCode: number | null): LadderState {
  if (exitCode === EXIT.done) return { ...state, reason: 'run finished' }
  if (exitCode === EXIT.auth) return { rung: 4, restarts: state.restarts, reason: 'devorch is not signed in (exit 77)' }
  if (exitCode === EXIT.notFound) return { rung: 4, restarts: state.restarts, reason: 'run not found or server too old (exit 66)' }
  if (state.restarts < MAX_RESTARTS) return { rung: 2, restarts: state.restarts + 1, reason: `watch child exited (${exitCode ?? 'killed'}); restarting` }
  return { rung: 3, restarts: state.restarts, reason: 'watch child keeps dying; using one-shot long-polls' }
}

/** A child that has stayed up long enough heals the ladder back to rung 1. */
export function afterHealthyChild(_state: LadderState): LadderState {
  return { rung: 1, restarts: 0, reason: 'watching' }
}

/**
 * The CLI handshake (`devorch version --json`): too old or missing -> rung 4. The feature tokens are always checked.
 * A local build (`build` is exactly `"dev"`: no `-p:Version` was passed, DEV-93) skips the MIN_CLI floor, because its
 * version is the csproj default rather than a release number. Anything else, including an absent `build` (every CLI
 * released before DEV-93), is a release and must clear the floor.
 */
// 0.23.0 is the first release whose Program.cs strips the global --plugin-option (39ce8a39, DEV-112) that the plugin's
// .mcp.json passes to `devorch mcp serve`; an older CLI on PATH would not start the MCP server at all (R16).
export const MIN_CLI = '0.23.0'
export const REQUIRED_FEATURES = ['run-watch', 'run-wait'] as const

/** The npm upgrade that brings the CLI to the plugin's version (no version pin for a `0.0.0-dev` plugin build). */
export function npmUpgrade(modVersion: string): string {
  return modVersion.startsWith('0.0.0') ? 'npm i -g dev-orchestrator-cli' : `npm i -g dev-orchestrator-cli@${modVersion}`
}

/** `modVersion` is the plugin's own version: a too-old CLI's reason names the npm upgrade to it (AC-16). */
export function cliSupports(versionJson: string | null, modVersion: string = '0.0.0-dev'): { ok: boolean; reason: string } {
  if (!versionJson) return { ok: false, reason: 'devorch CLI not found' }
  const upgrade = `update: ${npmUpgrade(modVersion)}`
  try {
    const v = JSON.parse(versionJson) as { version?: string; features?: string[]; build?: unknown }
    const missing = REQUIRED_FEATURES.filter((f) => !(v.features ?? []).includes(f))
    if (missing.length > 0) return { ok: false, reason: `devorch CLI lacks ${missing.join(', ')} (need ${MIN_CLI}+; ${upgrade})` }
    if (v.build === 'dev') return { ok: true, reason: `devorch ${v.version} (dev build)` }
    if (compareVersions(v.version ?? '0.0.0', MIN_CLI) < 0) return { ok: false, reason: `devorch CLI ${v.version} < ${MIN_CLI} (${upgrade})` }
    return { ok: true, reason: `devorch ${v.version}` }
  } catch {
    return { ok: false, reason: 'devorch version --json printed something unexpected' }
  }
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i += 1) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

// ---- the wake decision (AC-2, CC-5, CC-6) ---------------------------------------------------------------------

/** How long the session must be idle before a wake is submitted (CC-5). */
export const SETTLE_MS = 3_000

export interface WakeInputs {
  /** The run the session watches (the only id ever passed to a command). */
  watchedRunId: string | null
  /** A main-loop turn is running. */
  turnRunning: boolean
  /** Milliseconds since the last main-loop turn ended (null: none yet this session). */
  idleForMs: number | null
  /** The Stop-hook interactive host is armed (`.claude/hooks/interactive-loop/state/armed.json` exists). */
  stopHookArmed: boolean
  /** A wake for this run is queued and not yet consumed by a claim. */
  wakePending: boolean
  /** The latest run.position envelope for the watched run. */
  latest: PlatformEventEnvelope | null
  /** False under `wakeMode: poll`: the skill owns the wake, so the mod submits none (default true). */
  modWakes?: boolean
  /** The instruction this session's step skill claimed (`devorch_companion claimed`) and has not handed back, or null.
   * A leased CONTINUE for exactly this instruction is the session's own lease (DEV-113 C1, DEC-1). */
  ownClaim?: string | null
  /** The position token the last wake for this run was submitted for (or that the claim anchored), or null. A wake is
   * never submitted twice for the same unchanged token; any other token clears it (C3, X1). */
  submittedForToken?: string | null
}

/** Why a wake fires: `free` (a CONTINUE nobody leases), `own-lease` (a CONTINUE leased for the instruction this
 * session claimed, back from a blocker), `terminal` (a DONE/ABORT the driver must see to finish). */
export type WakeWhy = 'free' | 'own-lease' | 'terminal'

export type WakeDecision =
  | { wake: true; runId: string; why: WakeWhy }
  | { wake: false; reason: string; retryInMs?: number }

/**
 * Decide whether to wake the session with `/devorch:step <runId>`. Rules: no decision during a main-loop turn (the
 * latest envelope is re-evaluated once idle); wait out the settle window; never while the Stop-hook host is armed;
 * one pending wake per run, and never a second wake for the same unchanged position token (AC-6). Wake on a CONTINUE
 * nobody holds the lease on (`free`), on a CONTINUE leased for the instruction this session claimed (`own-lease`: a
 * blocker on it was answered while the session sat idle, AC-1), or on a DONE/ABORT the driver must see to finish
 * (`terminal`). A CONTINUE leased for anything else (another driver, or no claim after a mod reload) does not wake
 * (AC-10). A WAIT never wakes: the run is waiting on a human, and the next position change will.
 */
export function decideWake(i: WakeInputs): WakeDecision {
  const held = sessionHold(i)
  if (held) return held
  const runId = i.watchedRunId as string
  const latest = i.latest as PlatformEventEnvelope
  // GUIDs compare case-insensitively: the server writes them lowercase, a person may type them uppercase.
  if (latest.run?.externalId && latest.run.externalId.toLowerCase() !== runId.toLowerCase())
    return { wake: false, reason: 'envelope for another run' }
  const p = positionOf(latest)
  if (!p) return { wake: false, reason: 'not a position' }
  const why = wakeWhy(p, i.ownClaim ?? null)
  if (typeof why !== 'string') return why
  if (i.submittedForToken && i.submittedForToken === p.position) return { wake: false, reason: 'already woken for this position' }
  return { wake: true, runId, why }
}

/** The wake reason for a position before the same-token guard, or the no-wake decision. */
function wakeWhy(p: RunPositionData, ownClaim: string | null): WakeWhy | { wake: false; reason: string } {
  if (p.control === 'CONTINUE') {
    if (!p.leaseHeld) return 'free'
    return isOwnLease(p, ownClaim) ? 'own-lease' : { wake: false, reason: 'instruction already leased' }
  }
  if (p.control === 'DONE' || p.control === 'ABORT') return 'terminal'
  return { wake: false, reason: `run is ${p.control}` }
}

/** A leased CONTINUE for the instruction this session claimed (ids compare case-insensitively). */
export function isOwnLease(p: RunPositionData, ownClaim: string | null): boolean {
  return p.control === 'CONTINUE' && p.leaseHeld && ownClaim !== null && p.instructionId !== null
    && p.instructionId.toLowerCase() === ownClaim.toLowerCase()
}

/** The session-side reasons not to wake yet (no run, Stop-hook host, a turn, settling, a queued wake, no position),
 * or null when the session may be woken and `watchedRunId` and `latest` are set. */
function sessionHold(i: WakeInputs): WakeDecision | null {
  if (!i.watchedRunId) return { wake: false, reason: 'no run watched' }
  if (i.modWakes === false) return { wake: false, reason: 'wakeMode poll: the skill owns the wake' }
  if (i.stopHookArmed) return { wake: false, reason: 'Stop-hook host armed' }
  if (i.turnRunning) return { wake: false, reason: 'turn running; re-evaluate when idle' }
  if (i.idleForMs !== null && i.idleForMs < SETTLE_MS)
    return { wake: false, reason: 'settling', retryInMs: SETTLE_MS - i.idleForMs }
  if (i.wakePending) return { wake: false, reason: 'a wake is already queued' }
  if (!i.latest) return { wake: false, reason: 'no position yet' }
  return null
}

/** The pending-wake guard clears once the claim is visible (the lease is held) or the run moved on. */
export function clearsPendingWake(envelope: PlatformEventEnvelope): boolean {
  const p = positionOf(envelope)
  return p !== null && (p.leaseHeld || p.control !== 'CONTINUE')
}

// ---- the status band (no blocker or question text, ever) ------------------------------------------------------

/** How the status band names each rung of the source ladder. */
const RUNG_LABELS: Record<Rung, string> = { 1: 'live', 2: 'reconnecting', 3: 'polling', 4: 'offline' }

export function bandText(runId: string | null, latest: PlatformEventEnvelope | null, ladder: LadderState, stopHookArmed: boolean): string {
  if (stopHookArmed) return 'DevOrch: Stop-hook host armed'
  if (!runId) return 'DevOrch: not watching a run (/devorch-watch <runId>)'
  const short = runId.slice(0, 8)
  const rung = RUNG_LABELS[ladder.rung]
  const p = latest ? positionOf(latest) : null
  if (!p) return `DevOrch ${short}: waiting for position (${rung})`
  const blockers = p.openBlockers.length > 0 ? ` | blockers: ${p.openBlockers.map((b) => `${b.ref} [${b.kind}]`).join(', ')}` : ''
  const why = p.reasonCode ? ` (${p.reasonCode})` : ''
  return `DevOrch ${short}: ${p.control}${why}${blockers} | ${rung}`
}

// ---- /devorch-answer (the answer text never goes in argv) -----------------------------------------------------

/** The argv for `devorch blocker answer` with the answer in a temp file (never on the command line). */
export function answerArgv(devorch: string, slug: string, blockerRef: string, answerFile: string): string[] {
  // A leading '-' would be parsed by the CLI as an option (--text, --stdin...), so ids must start alphanumeric.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(slug)) throw new Error('invalid work item slug')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(blockerRef)) throw new Error('invalid blocker ref')
  return [devorch, 'blocker', 'answer', slug, blockerRef, '--file', answerFile, '--json']
}

/** Parse `/devorch-answer <slug> <ref> <answer...>`. */
export function parseAnswerArgs(args: string): { slug: string; blockerRef: string; answer: string } | null {
  const match = /^\s*(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(args)
  if (!match) return null
  const [, slug = '', blockerRef = '', rest = ''] = match
  const answer = rest.trim()
  return answer.length > 0 ? { slug, blockerRef, answer } : null
}

/**
 * The step skill this plugin ships, as Claude Code names a plugin skill: `/<plugin>:<skill>`. The plugin name
 * (`plugin.json`), the skill folder (`skills/step/`) and this literal are one naming unit: rename them together.
 * There is no bare-name fallback (DEV-122 TQ-10): the wake submits only the skill that ships with this mod.
 */
export const PLUGIN_STEP_COMMAND = 'devorch:step'

/**
 * The only command the mod ever submits: the plugin's step skill with the run id it holds and nothing else
 * (CC-4, AC-906). An unknown command is rejected by the host, which the adapter reads as `healthy: false`.
 */
export function wakeCommand(runId: string): { command: string; args: string } {
  if (!/^[0-9a-fA-F-]{36}$/.test(runId)) throw new Error('not a run id')
  return { command: PLUGIN_STEP_COMMAND, args: runId }
}
