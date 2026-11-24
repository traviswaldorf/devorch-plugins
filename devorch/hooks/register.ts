import type { EngineInterface, Register, Timer } from 'claude-code'

import {
  EventDispatcher, LineSplitter, SETTLE_MS, afterHealthyChild, cliSupports, clearsPendingWake, decideWake,
  parseAnswerArgs, parseEnvelope, positionOf, wakeCommand, type LadderState, type PlatformEventEnvelope,
} from './core.ts'
import {
  HEAL_MS, LOG_MAX_BYTES, NO_CLAIM, WAKE_EXPIRY_MS, afterClaimed, afterHandback, afterPoll, afterPositionLine,
  afterWakeClaimed, afterWakeExpired, afterWakeSubmitted, afterWatchExit, clearsPendingOnTurnStart, isInstructionId,
  answerStdinArgv, canWatch, configGetArgv, dedupe, handBackWake, health, isBaseUrl, logLine, modWakes, nextSettings,
  parseConfigView, parseUnwatchArgs, parseWatchArgs, pollTimeoutMs, resolveExe, respawnDelayMs, restoreWatched, runStatus,
  SETTINGS_DEBOUNCE_MS, SETTINGS_POLL_MS, settingsHint, settingsSignature, statusLine, terminalAction, tokenOf, UNRESOLVED,
  updateHint, versionArgv, waitArgv, wakePolicy, watchArgv, type ClaimState, type Settings, type WakeHealth,
  type WatchEntry,
} from './supervision.ts'

/**
 * DevOrch companion mod: the thin host adapter over `$` (DEV-56, design-L0 "Adapter code paths").
 *
 * This file only performs host calls (process spawn/run, timers, `$.command.run`, the status line, tool and command
 * registration, `$.state`); every decision comes from `core.ts` or `supervision.ts`, which are node-tested. A branch
 * on data that is not a plain host call belongs in `supervision.ts` with a test.
 *
 * The host requires `$` to be spelled `$.noun.op(...)` at each call site (never stored or passed), so every function
 * that calls the host is a closure inside the `session.start` hook and the other hooks reach them through `ops`.
 * Long-lived loops (one per watched run) keep running after that hook returns, as the host's spawn example shows.
 *
 * Invariants (design-L0 Domain Integrity Constraints):
 * - only `wakeCommand(runId)` reaches `$.command.run`: the plugin's step skill (`devorch:step`) with a run id the
 *   mod validated (CC-4);
 * - no blocker or question text in the status line, toasts, tool results, command replies or the log (CC-4, D19);
 * - no wake inside a main-loop turn or within SETTLE_MS of its end (CC-5), none while the Stop-hook host is armed (CC-6);
 * - one long-lived `devorch run watch` child per watched run on rungs 1-2, zero processes per event (AC-4);
 * - the mod reaches the server only through the CLI's argv and stdout: no HTTP call, no token.
 *
 * Spike-conditional branches (design-L0): this file implements the DEFAULT branch of each row (no console flash on
 * spawn/run, main-loop `turn.complete` with `agentId` undefined, `$.command.run` queues until idle and accepts the
 * step skill, a `clock.after` scheduled in `turn.complete` runs outside the turn). The Windows spike
 * (`spike-tq27.md`) confirms or changes them; a rejected wake already degrades to `healthy: false`.
 */

const TOOL = 'mcp__devorch__companion'
const STOP_HOOK_MARKER = '.claude/hooks/interactive-loop/state/armed.json'
/** How long tool `watch` waits for the first envelope or child exit before it answers (D16). */
const FIRST_SIGNAL_MS = 5_000

type Run = {
  entry: WatchEntry
  ladder: LadderState
  latest: PlatformEventEnvelope | null
  lastToken: string | null
  pendingWake: boolean
  /** The instruction the step skill claimed and the token a wake must not fire for again (DEV-113 C1-C3). */
  claim: ClaimState
  expiry: Timer | null
  retry: Timer | null
  child: AsyncGenerator<unknown, unknown> | null
  stopped: boolean
  /** The tool told the skill `healthy: true` for this run (D16). */
  reportedHealthy: boolean
  handedBack: boolean
  firstSignal: (() => void)[]
  sawFirst: boolean
  retryWatch: boolean
}

type Cli = { ok: boolean; reason: string; exe: string | null; version: string | null; features: string[] }

/** The host-calling operations the session.start hook builds; the other hooks call these. */
type Ops = {
  watch: (runId: string, baseUrl: unknown, lastToken?: string | null) => Promise<Run>
  unwatch: (runId: string) => Promise<void>
  firstSignal: (run: Run) => Promise<void>
  evaluateAll: () => void
  answer: (slug: string, blockerRef: string, text: string) => Promise<string>
  /** The step skill's claim handshake (C1/C4): `claimed` after a CONTINUE fetch, `handback` after apply. */
  claim: (run: Run, action: 'claimed' | 'handback', instructionId: string) => void
  /** A main-loop turn started: it consumes any pending wake (C3, G-18). */
  mainTurnStarted: () => void
  shutdown: () => Promise<void>
}

export const register: Register = (on, options) => {
  const runs = new Map<string, Run>()
  const dispatcher = new EventDispatcher(() => {})
  let ops: Ops | null = null
  let cli: Cli = { ok: false, reason: 'not started', exe: null, version: null, features: [] }
  let stopHookArmed = false
  let wakeHealth: WakeHealth = { misses: 0, wakeBroken: false }
  let turnRunning = false
  let lastTurnEnd: number | null = null
  /** apiBase, wake mode and timing knobs: the CLI's resolved view (`devorch config get --json`), refreshed when a
   * settings file changes. The mod computes no precedence (DEV-112 K12); before the first resolve it knows nothing. */
  let settings: Settings = UNRESOLVED
  /** Diagnostics for the status action: the last wake decision and how far the last submit got. */
  const diag: { decision?: { at: number; wake: boolean; reason?: string; why?: string }; submit?: { at: number; stage: string } } = {}

  const now = (): number => Date.now()
  const idleForMs = (): number | null => (lastTurnEnd === null ? null : now() - lastTurnEnd)

  // ---- pure views over the state (no host calls) ----------------------------------------------------------------

  function healthOf(run: Run | null): { healthy: boolean; reason?: string } {
    return health({
      pollMode: settings.wakeMode === 'poll', cliOk: cli.ok, cliReason: cli.reason, stopHookArmed,
      wakeBroken: wakeHealth.wakeBroken, rung: run ? run.ladder.rung : null,
    })
  }

  /** The effective wake policy the skills branch on (`wake.effective`). */
  function wakeOf(run: Run | null): ReturnType<typeof wakePolicy> {
    return wakePolicy(settings.wakeMode, healthOf(run), settings.fallbackWakeupSeconds)
  }

  function statusObject(runId?: string): Record<string, unknown> {
    const asked = runId ? runs.get(runId) ?? null : null
    return {
      ...healthOf(asked),
      wake: wakeOf(asked),
      config: {
        apiBase: settings.apiBase,
        wakeMode: settings.wakeMode,
        fallbackWakeupSeconds: settings.fallbackWakeupSeconds,
        longPollSeconds: settings.longPollSeconds,
        // Where each value came from, as `devorch config get --show-origin` names it.
        origins: settings.resolved || settings.apiBase ? settings.origins : 'unresolved',
        root: settings.root,
        files: settings.files,
        warnings: settings.warnings,
        errors: settings.errors,
      },
      cli: { ok: cli.ok, version: cli.version, path: cli.exe },
      stopHookArmed,
      wakeBroken: wakeHealth.wakeBroken,
      turnRunning,
      idleForMs: idleForMs(),
      lastDecision: diag.decision ?? null,
      lastSubmit: diag.submit ?? null,
      runs: [...runs.values()]
        .filter((r) => !runId || r.entry.runId === runId)
        .map((r) => ({ ...runStatus({ runId: r.entry.runId, baseUrl: r.entry.baseUrl, pendingWake: r.pendingWake, latest: r.latest, ladder: r.ladder, claim: r.claim }), healthy: healthOf(r).healthy })),
    }
  }

  function signalFirst(run: Run): void {
    run.sawFirst = true
    for (const resolve of run.firstSignal.splice(0)) resolve()
  }

  // ---- session lifecycle (R1: registration stays out of session.start's awaited path) ---------------------------

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const cwd = e.cwd
    const queue: string[] = []
    let pluginRoot = ''
    let dataDir = ''
    let modVersion = '0.0.0-dev'
    let wakeInFlight: string | null = null
    let logLines: string[] = []
    let logBytes = 0
    let logFlush: Timer | null = null

    // ---- logging (D19: ids and timings only) ------------------------------------------------------------------

    function log(runId: string, event: string, extra: Parameters<typeof logLine>[3] = {}): void {
      const line = logLine(now(), runId, event, extra)
      logLines.push(line)
      logBytes += line.length + 1
      if (!dataDir) return
      logFlush ??= $.clock.after(1_000, () => {
        logFlush = null
        void flushLog()
      })
    }

    async function flushLog(): Promise<void> {
      if (!dataDir) return
      try {
        if (logBytes > LOG_MAX_BYTES) {
          await $.fs.write(`${dataDir}/companion.log.1`, logLines.join('\n') + '\n')
          logLines = []
          logBytes = 0
        }
        await $.fs.write(`${dataDir}/companion.log`, logLines.join('\n') + (logLines.length ? '\n' : ''))
      } catch {
        // the log is for measurement only; never fail a wake over it
      }
    }

    // ---- status line and the hand-back wake (D6, D7, D16) ------------------------------------------------------

    function redraw(): void {
      const views = [...runs.values()].map((r) => ({ runId: r.entry.runId, latest: r.latest, ladder: r.ladder }))
      const hints = [cli.ok && cli.version ? updateHint(modVersion, cli.version, cli.features) : null, settings.wakeMode === 'poll' ? 'wake: poll' : null, settingsHint(settings)]
      const hint = hints.filter((h) => h !== null).join(' | ') || null
      $.ui.status(cli.ok ? statusLine(views, stopHookArmed, hint) : `DevOrch: offline (${cli.reason})`)
    }

    function checkHandBack(run: Run): void {
      const nowHealthy = healthOf(run).healthy
      if (nowHealthy) {
        run.handedBack = false
        return
      }
      if (modWakes(settings.wakeMode) && handBackWake({ reportedHealthy: run.reportedHealthy, nowHealthy, stopHookArmed, handedBack: run.handedBack })) {
        run.handedBack = true
        run.reportedHealthy = false
        $.clock.after(0, () => void submit(run.entry.runId, 'hand-back', null))
      }
    }

    // ---- the watched set in $.state (D10) ----------------------------------------------------------------------

    async function persist(): Promise<void> {
      const value = { runs: [...runs.values()].map((r) => ({ ...r.entry, ...(r.lastToken ? { lastToken: r.lastToken } : {}) })) }
      try {
        await $.state.set({ plugin: 'devorch', key: 'watched' }, value)
      } catch {
        // session state is a convenience for hot reload; the server's position stays authoritative
      }
    }

    // ---- wakes (D2, D3, CC-5, CC-6) ----------------------------------------------------------------------------

    function evaluateAll(): void {
      for (const run of runs.values()) evaluate(run)
    }

    function evaluate(run: Run): void {
      if (run.stopped) return
      const decision = decideWake({
        watchedRunId: run.entry.runId,
        turnRunning,
        idleForMs: idleForMs(),
        stopHookArmed,
        wakePending: run.pendingWake,
        latest: run.latest,
        modWakes: modWakes(settings.wakeMode),
        ownClaim: run.claim.claimedInstructionId,
        submittedForToken: run.claim.submittedForToken,
      })
      diag.decision = { at: now(), wake: decision.wake, ...(decision.wake ? { why: decision.why } : { reason: decision.reason }) }
      if (decision.wake) {
        if (wakeInFlight && wakeInFlight !== run.entry.runId) {
          if (!queue.includes(run.entry.runId)) queue.push(run.entry.runId)
          return
        }
        const why = decision.why
        $.clock.after(0, () => void submit(run.entry.runId, 'wake', why))
      } else if (decision.retryInMs !== undefined) {
        $.clock.after(decision.retryInMs, () => evaluate(run))
      }
    }

    async function submit(runId: string, why: 'wake' | 'hand-back', wakeWhy: string | null): Promise<void> {
      const run = runs.get(runId)
      if (!run) return
      diag.submit = { at: now(), stage: 'entered' }
      stopHookArmed = await $.fs.exists(`${cwd}/${STOP_HOOK_MARKER}`).catch(() => false)
      diag.submit = { at: now(), stage: 'marker-checked' }
      if (stopHookArmed) {
        redraw()
        return
      }
      if (why === 'wake') {
        if (run.pendingWake || turnRunning) {
          diag.submit = { at: now(), stage: run.pendingWake ? 'skipped: pending' : 'skipped: turn running' }
          return
        }
        run.pendingWake = true
        // One submit per unchanged position (AC-6): an expiry re-evaluation of this token refuses (G-17).
        run.claim = afterWakeSubmitted(run.claim, run.latest ? tokenOf(run.latest) : run.lastToken)
        run.expiry?.cancel()
        run.expiry = $.clock.after(WAKE_EXPIRY_MS, () => onWakeExpired(run))
      }
      wakeInFlight = runId
      log(runId, why === 'wake' ? 'wake-submitted' : 'hand-back-submitted', { token: run.lastToken, ...(wakeWhy ? { why: wakeWhy } : {}) })
      try {
        // The plugin's step skill (/devorch:step); the host rejects it if the skill is not loaded.
        diag.submit = { at: now(), stage: 'command.run called' }
        await $.command.run(wakeCommand(runId))
        diag.submit = { at: now(), stage: 'command.run resolved' }
      } catch (err) {
        diag.submit = { at: now(), stage: `command.run rejected: ${String(err).slice(0, 200)}` }
        // Rejected (unknown name, busy, past a Stop): the wake mechanism is broken for this build, so the skill's
        // own ScheduleWakeup must own the wake (D6). Spike rows TQ-3/TQ-12 decide whether a different path exists.
        run.pendingWake = false
        run.expiry?.cancel()
        wakeHealth = { ...wakeHealth, wakeBroken: true }
        $.ui.toast('DevOrch: could not wake the session; the step skill keeps its own wakeup')
        log(runId, 'wake-rejected')
        redraw()
        for (const r of runs.values()) checkHandBack(r)
      } finally {
        if (wakeInFlight === runId) wakeInFlight = null
        const nextRunId = queue.shift()
        const queued = nextRunId ? runs.get(nextRunId) : undefined
        if (queued) evaluate(queued)
      }
    }

    function onWakeExpired(run: Run): void {
      if (!run.pendingWake || run.stopped) return
      run.pendingWake = false
      run.expiry = null
      const r = afterWakeExpired(wakeHealth)
      wakeHealth = { misses: r.misses, wakeBroken: r.wakeBroken }
      $.ui.toast(r.toast)
      log(run.entry.runId, 'wake-expired')
      redraw()
      if (r.reevaluate) evaluate(run)
      checkHandBack(run)
    }

    // ---- one line from the CLI ---------------------------------------------------------------------------------

    async function onLine(run: Run, line: string): Promise<void> {
      const envelope = parseEnvelope(line)
      if (!envelope || run.stopped) return
      const d = dedupe(run.lastToken, envelope)
      if (!d.dispatch) return
      if (d.lastToken !== run.lastToken) {
        run.lastToken = d.lastToken
        void persist()
      }
      log(run.entry.runId, 'line', { token: tokenOf(envelope), rung: run.ladder.rung })
      signalFirst(run)

      let terminal: 'none' | 'seen' | 'wake' = 'none'
      if (positionOf(envelope)) {
        run.latest = envelope
        // X1: the same-token memory survives only an unchanged token; a pending claim anchor adopts the own lease.
        run.claim = afterPositionLine(run.claim, envelope)
        if (run.pendingWake && clearsPendingWake(envelope)) {
          run.pendingWake = false
          run.expiry?.cancel()
          run.expiry = null
          wakeHealth = afterWakeClaimed(wakeHealth)
          log(run.entry.runId, 'wake-claimed', { token: run.lastToken })
        }
        terminal = terminalAction(envelope, turnRunning, idleForMs())
      }
      redraw()
      await dispatcher.dispatch(envelope)
      if (terminal === 'seen') {
        $.ui.toast(`DevOrch: run ${run.entry.runId.slice(0, 8)} finished`)
        await unwatch(run.entry.runId)
        return
      }
      evaluate(run)
    }

    // ---- the source ladder (D4, D5) ----------------------------------------------------------------------------

    function setLadder(run: Run, ladder: LadderState): void {
      const before = run.ladder.rung
      run.ladder = ladder
      if (ladder.rung !== before) {
        log(run.entry.runId, 'rung', { rung: ladder.rung })
        if (ladder.rung >= 3) $.ui.toast(`DevOrch: run ${run.entry.runId.slice(0, 8)} ${ladder.reason}`)
      }
      redraw()
      checkHandBack(run)
    }

    async function superviseWatch(run: Run): Promise<void> {
      const exe = cli.exe
      if (!exe) return offline(run)
      while (!run.stopped && (run.ladder.rung === 1 || run.ladder.rung === 2)) {
        const heal = $.clock.after(HEAL_MS, () => setLadder(run, afterHealthyChild(run.ladder)))
        let code: number | null = null
        try {
          const child = $.process.spawn({ argv: watchArgv(exe, run.entry.runId, run.entry.baseUrl, run.lastToken) })
          run.child = child
          log(run.entry.runId, 'spawn', { rung: run.ladder.rung })
          const splitter = new LineSplitter()
          for (;;) {
            const piece = await child.next()
            if (piece.done) {
              code = piece.value.code
              break
            }
            if (piece.value.stream !== 'stdout') continue
            for (const line of splitter.push(piece.value.text)) await onLine(run, line)
          }
          for (const line of splitter.flush()) await onLine(run, line)
        } catch {
          code = null // could not start, or killed
        } finally {
          heal.cancel()
          run.child = null
        }
        if (run.stopped) return
        log(run.entry.runId, 'exit', { exitCode: code, rung: run.ladder.rung })
        signalFirst(run)
        if (code === 0) {
          $.ui.toast(`DevOrch: run ${run.entry.runId.slice(0, 8)} finished`)
          await unwatch(run.entry.runId)
          return
        }
        setLadder(run, afterWatchExit(run.ladder, code))
        if (run.ladder.rung === 2) await $.clock.sleep(respawnDelayMs(run.ladder.restarts)).catch(() => {})
      }
      if (run.stopped) return
      if (run.ladder.rung === 3) return pollLoop(run)
      return offline(run)
    }

    /** Rung 3: sequential one-shot long-polls; retries the watch child every 10 minutes (D4, D5). */
    async function pollLoop(run: Run): Promise<void> {
      const exe = cli.exe
      if (!exe) return offline(run)
      run.retryWatch = false
      run.retry?.cancel()
      run.retry = $.clock.after(HEAL_MS, () => {
        run.retryWatch = true
      })
      let failures = 0
      while (!run.stopped && run.ladder.rung === 3) {
        let exitCode = 75
        let stdout = ''
        try {
          const argv = waitArgv(exe, run.entry.runId, run.entry.baseUrl, run.lastToken, settings.longPollSeconds)
          const r = await $.process.run(argv, { timeoutMs: pollTimeoutMs(settings.longPollSeconds) })
          exitCode = r.exitCode
          stdout = r.stdout
        } catch {
          exitCode = 75 // could not start or timed out: treat as transport
        }
        if (run.stopped) return
        signalFirst(run)
        const outcome = afterPoll(exitCode, failures)
        if (outcome.kind === 'line') {
          failures = 0
          for (const line of new LineSplitter().push(stdout + '\n')) await onLine(run, line)
        } else if (outcome.kind === 'retry') {
          failures = outcome.failures
          await $.clock.sleep(outcome.delayMs).catch(() => {})
        } else if (outcome.kind === 'offline') {
          setLadder(run, { rung: 4, restarts: run.ladder.restarts, reason: outcome.reason })
          return offline(run)
        }
        if (run.retryWatch) {
          run.retry?.cancel()
          run.retry = null
          setLadder(run, { rung: 1, restarts: 0, reason: 'retrying the watch child' })
          return superviseWatch(run)
        }
      }
    }

    /** Rung 4: no source; `healthy: false` hands the wake to the skill. Retries the handshake every 10 minutes. */
    function offline(run: Run): void {
      if (run.stopped) return
      if (run.ladder.rung !== 4) setLadder(run, { rung: 4, restarts: run.ladder.restarts, reason: cli.reason })
      run.retry?.cancel()
      run.retry = $.clock.after(HEAL_MS, () => void retryOffline(run))
    }

    async function retryOffline(run: Run): Promise<void> {
      if (run.stopped) return
      await handshake()
      if (!cli.ok) return offline(run)
      setLadder(run, { rung: 1, restarts: 0, reason: 'watching' })
      void superviseWatch(run)
    }

    // ---- watch / unwatch ---------------------------------------------------------------------------------------

    /** A watch's base URL: the one it names, else the resolved apiBase (resolving first if nothing is known yet). */
    async function defaultBaseUrl(explicit?: unknown): Promise<string> {
      if (isBaseUrl(explicit)) return explicit.replace(/\/+$/, '')
      if (settings.apiBase === null) await refreshSettings()
      if (settings.apiBase === null) throw new Error(`DevOrch settings unavailable: ${settings.errors[0] ?? cli.reason}`)
      return settings.apiBase
    }

    // ---- settings: one `config get` at start and after a settings file changes (K12) ---------------------------

    let settingsSig: string | null = null
    let settingsPending: Timer | null = null
    let resolving: Promise<void> | null = null

    async function refreshSettings(): Promise<void> {
      resolving ??= (async () => {
        try {
          if (!cli.exe) await handshake()
          if (!cli.exe) {
            settings = { ...settings, errors: [cli.reason] }
            return
          }
          let stdout: string | null = null
          let failure: string | null = null
          try {
            const r = await $.process.run(configGetArgv(cli.exe, cwd, options as Record<string, unknown> | undefined), { timeoutMs: 15_000 })
            if (r.exitCode === 0) stdout = r.stdout
            else failure = `devorch config get exited ${r.exitCode}${r.exitCode === 129 || r.exitCode === 1 ? ' (update devorch: settings files need config get)' : ''}`
          } catch {
            failure = 'devorch config get could not run'
          }
          const before = settings
          settings = nextSettings(settings, failure ? { ok: false, error: failure } : parseConfigView(stdout))
          if (before.wakeMode !== settings.wakeMode) evaluateAll()
          settingsSig = await filesSignature()
        } finally {
          resolving = null
          redraw()
        }
      })()
      return resolving
    }

    async function filesSignature(): Promise<string> {
      const stats = await Promise.all(settings.files.map((f) => $.fs.stat(f).catch(() => null)))
      return settingsSignature(stats.map((s) => (s ? { mtimeMs: s.mtimeMs, size: s.size } : null)))
    }

    /** Every SETTINGS_POLL_MS: stat the settings files (no process); on a change, one debounced `config get`. */
    async function checkSettingsFiles(): Promise<void> {
      if (resolving || settingsPending || settingsSig === null) return
      const sig = await filesSignature().catch(() => settingsSig)
      if (sig === settingsSig) return
      settingsPending = $.clock.after(SETTINGS_DEBOUNCE_MS, () => {
        settingsPending = null
        void refreshSettings()
      })
    }

    async function watch(rawRunId: string, baseUrl: unknown, lastToken: string | null = null): Promise<Run> {
      const runId = rawRunId.toLowerCase()
      const existing = runs.get(runId)
      if (existing) {
        if (existing.ladder.rung === 4) void retryOffline(existing)
        return existing
      }
      const run: Run = {
        entry: { runId, baseUrl: await defaultBaseUrl(baseUrl), addedAt: now() },
        ladder: { rung: 1, restarts: 0, reason: 'watching' },
        latest: null, lastToken, pendingWake: false, claim: NO_CLAIM, expiry: null, retry: null, child: null, stopped: false,
        reportedHealthy: false, handedBack: false, firstSignal: [], sawFirst: false, retryWatch: false,
      }
      runs.set(runId, run)
      await persist()
      log(runId, 'watch')
      redraw()
      if (!cli.ok) await handshake()
      if (cli.ok) void superviseWatch(run)
      else offline(run)
      return run
    }

    async function stop(run: Run): Promise<void> {
      run.stopped = true
      run.expiry?.cancel()
      run.retry?.cancel()
      signalFirst(run)
      try {
        await run.child?.return(undefined) // ends the loop, which kills the child
      } catch {
        // already gone
      }
    }

    async function unwatch(rawRunId: string): Promise<void> {
      const runId = rawRunId.toLowerCase()
      const run = runs.get(runId)
      if (!run) return
      await stop(run)
      runs.delete(runId)
      log(runId, 'unwatch')
      await persist()
      redraw()
    }

    /** Waits for the first envelope or child exit, at most FIRST_SIGNAL_MS (D16). */
    async function firstSignal(run: Run): Promise<void> {
      if (run.sawFirst) return
      await Promise.race([
        new Promise<void>((resolve) => run.firstSignal.push(resolve)),
        $.clock.sleep(FIRST_SIGNAL_MS).catch(() => {}),
      ])
    }

    // ---- the CLI handshake (D8, D13) ---------------------------------------------------------------------------

    async function readText(path: string): Promise<string | null> {
      try {
        const text = await $.fs.read(path)
        return typeof text === 'string' ? text : null
      } catch {
        return null
      }
    }

    async function handshake(): Promise<void> {
      // AC-15: DEVORCH_EXE -> userConfig.devorchExe -> PATH (absolute; an npm .cmd hit maps to the exe behind it).
      const windows = await $.session.info().then((i) => i.platform === 'windows').catch(() => false)
      const resolved = await resolveExe(
        {
          env: (await $.env.get('DEVORCH_EXE')) ?? undefined,
          userConfig: options?.devorchExe,
          path: (await $.env.get('PATH')) ?? undefined,
          pathext: (await $.env.get('PATHEXT')) ?? undefined,
          windows,
        },
        (path) => $.fs.exists(path),
      )
      if (resolved.exe === null) {
        cli = { ok: false, reason: resolved.reason, exe: null, version: null, features: [] }
        redraw()
        return
      }
      let stdout: string | null = null
      try {
        const r = await $.process.run(versionArgv(resolved.exe), { timeoutMs: 15_000 })
        stdout = r.exitCode === 0 ? r.stdout : null
      } catch {
        stdout = null
      }
      const supports = cliSupports(stdout, modVersion)
      let version: string | null = null
      let features: string[] = []
      try {
        const v = stdout ? (JSON.parse(stdout) as { version?: string; features?: unknown }) : null
        version = v?.version ?? null
        features = Array.isArray(v?.features) ? v.features.filter((f): f is string => typeof f === 'string') : []
      } catch {
        version = null
      }
      cli = { ok: supports.ok, reason: supports.ok ? supports.reason : `${supports.reason} (${resolved.source}: ${resolved.exe})`, exe: resolved.exe, version, features }
      redraw()
    }

    // ---- /devorch-answer: the answer goes on stdin, never in argv, and is never echoed (CC-4) ------------------

    async function answer(slug: string, blockerRef: string, text: string): Promise<string> {
      if (!cli.exe) await handshake()
      const exe = cli.exe
      if (!exe) return `devorch CLI unavailable: ${cli.reason}`
      // One watched base URL when every watched run shares it; otherwise the configured default.
      const bases = new Set([...runs.values()].map((r) => r.entry.baseUrl))
      let baseUrl: string
      try {
        baseUrl = bases.size === 1 ? ([...bases][0] as string) : await defaultBaseUrl()
      } catch (error) {
        return `Not sent: ${error instanceof Error ? error.message : 'no base URL'}`
      }
      let argv: string[]
      try {
        argv = answerStdinArgv(exe, slug, blockerRef, baseUrl)
      } catch (error) {
        return `Not sent: ${error instanceof Error ? error.message : 'invalid arguments'}`
      }
      try {
        const r = await $.process.run(argv, { stdin: text, timeoutMs: 30_000 })
        return r.exitCode === 0 ? `answered ${blockerRef}` : `devorch blocker answer failed (exit ${r.exitCode})`
      } catch {
        return 'devorch blocker answer could not run'
      }
    }

    async function shutdown(): Promise<void> {
      settingsPoll?.cancel()
      settingsPending?.cancel()
      for (const run of [...runs.values()]) await stop(run)
      await flushLog()
    }

    function claim(run: Run, action: 'claimed' | 'handback', instructionId: string): void {
      run.claim = action === 'claimed' ? afterClaimed(run.claim, instructionId, run.latest) : afterHandback(run.claim, instructionId)
      log(run.entry.runId, action, { token: run.claim.submittedForToken })
    }

    function mainTurnStarted(): void {
      for (const run of runs.values()) {
        if (!clearsPendingOnTurnStart(undefined, run.pendingWake)) continue
        run.pendingWake = false
        run.expiry?.cancel()
        run.expiry = null
        wakeHealth = afterWakeClaimed(wakeHealth)
        log(run.entry.runId, 'wake-consumed', { token: run.lastToken })
      }
    }

    ops = { watch, unwatch, firstSignal, evaluateAll, answer, claim, mainTurnStarted, shutdown }

    let settingsPoll: Timer | null = null

    void (async () => {
      try {
        const env = await $.process.hookEnv()
        pluginRoot = env.CLAUDE_PLUGIN_ROOT ?? ''
        dataDir = env.CLAUDE_PLUGIN_DATA ?? ''
        const manifest = pluginRoot ? await readText(`${pluginRoot}/.claude-plugin/plugin.json`) : null
        modVersion = manifest ? ((JSON.parse(manifest) as { version?: string }).version ?? modVersion) : modVersion
      } catch {
        // no data folder: the log stays in memory
      }
      try {
        await $.tool.register({
          name: 'companion',
          description:
            'The DevOrch companion mod. status {runId?}: the wake policy for the run in `wake` (effective "push": the ' +
            'companion wakes this session, run the step once and schedule nothing; "poll": the skill drives /loop + ' +
            'ScheduleWakeup with wake.fallbackWakeupSeconds; "unavailable": wakeMode push but the companion is ' +
            'unhealthy, report and stop), plus healthy, config and each watched run\'s rung, control, lease and open ' +
            'blocker refs. watch {runId, baseUrl?}: arm the watch for a run this session drives (answers after the ' +
            'first event, at most 5 s, with the same wake field). unwatch {runId}: stop. claimed {runId, ' +
            'instructionId}: call right after get_next_instruction returns CONTINUE, so that a blocker answered on ' +
            'this session\'s own lease wakes it. handback {runId, instructionId}: call right after ' +
            'apply_instruction_result.',
          inputSchema: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['status', 'watch', 'unwatch', 'claimed', 'handback'] },
              runId: { type: 'string', description: 'SdlcRun external id (GUID).' },
              instructionId: { type: 'string', description: 'The instruction id (GUID), for claimed and handback.' },
              baseUrl: { type: 'string', description: 'The DevOrch API base URL the run lives on, when not the default.' },
            },
            required: ['action'],
          },
        })
        await $.command.register({ name: 'devorch-watch', description: 'Watch a DevOrch run (no argument: list watched runs).', argumentHint: '[runId] [baseUrl]', immediate: true })
        await $.command.register({ name: 'devorch-unwatch', description: 'Stop watching a DevOrch run.', argumentHint: '<runId|all>', immediate: true })
        await $.command.register({ name: 'devorch-answer', description: 'Answer an open DevOrch blocker.', argumentHint: '<slug> <ref> <answer...>', immediate: true })
      } catch {
        $.ui.toast('DevOrch: could not register the companion tool and commands')
      }
      stopHookArmed = await $.fs.exists(`${cwd}/${STOP_HOOK_MARKER}`).catch(() => false)
      await handshake()
      // The CLI resolves every setting (files, plugin options, env); the mod only reads the view (DEV-112 K12).
      await refreshSettings()
      for (const w of settings.warnings) $.ui.toast(`DevOrch: ${w}`)
      settingsPoll = $.clock.every(SETTINGS_POLL_MS, () => void checkSettingsFiles())
      const held = await $.state.get({ plugin: 'devorch', key: 'watched' }).catch(() => ({ value: undefined }))
      // No --since on restore: the session lost `latest` with the reload, so it needs the current position now,
      // not the next change (a parked run would otherwise leave the restored watch with nothing to wake on).
      for (const entry of restoreWatched(held.value)) await watch(entry.runId, entry.baseUrl, null)
      redraw()
    })()
    return started
  })

  on('session.end', async ($, e, next) => {
    await ops?.shutdown()
    return next(e)
  })

  // ---- turn tracking (CC-5; spike TQ-2 default branch: main loop = agentId undefined) ---------------------------

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      turnRunning = true
      // The woken step skill (or the person's own prompt) is running: the pending wake is consumed (C3, X5).
      ops?.mainTurnStarted()
    }
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      turnRunning = false
      lastTurnEnd = now()
      // Re-evaluate once the settle window has passed, from a timer: never submit inside the hook (D2, TQ-13).
      $.clock.after(SETTLE_MS, () => ops?.evaluateAll())
    }
    return next(e)
  })

  // ---- the generic event hook for other plugins (D9, AC-3): subscribe and read only ------------------------------

  on('engine.create', async (_$, e, next) => {
    const beneath: Omit<EngineInterface, 'devorch'> = await next(e)
    return {
      ...beneath,
      devorch: {
        on: (pattern: string, handler: (envelope: PlatformEventEnvelope) => void | Promise<void>) => dispatcher.on(pattern, handler),
        latest: (runId: string) => runs.get(runId.toLowerCase())?.latest ?? null,
        status: () => statusObject() as never,
      },
    }
  })

  // ---- the model tool (D6, D16) ---------------------------------------------------------------------------------

  on('tool.run', { tool: TOOL }, async ($, e) => {
    const raw = e as unknown as { action?: unknown; runId?: unknown; baseUrl?: unknown; instructionId?: unknown }
    const input = { ...raw, runId: typeof raw.runId === 'string' ? raw.runId.toLowerCase() : raw.runId }
    const reply = (value: unknown) => ({ result: JSON.stringify(value) }) as never
    if (input.action === 'status') {
      const runId = typeof input.runId === 'string' ? input.runId : undefined
      const value = statusObject(runId)
      if (value.healthy === true) for (const r of runs.values()) if (!runId || r.entry.runId === runId) r.reportedHealthy = true
      return reply(value)
    }
    if (!ops) return reply({ watching: false, healthy: false, reason: 'companion not started' })
    if (input.action === 'watch') {
      const runId = String(input.runId ?? '')
      const allowed = canWatch([...runs.keys()], runId)
      if (!allowed.ok) return reply({ watching: false, healthy: false, reason: allowed.reason })
      if (input.baseUrl !== undefined && !isBaseUrl(input.baseUrl)) return reply({ watching: false, healthy: false, reason: 'baseUrl must be an http(s) URL' })
      let run: Run
      try {
        run = await ops.watch(runId, input.baseUrl)
      } catch (error) {
        return reply({ watching: false, healthy: false, reason: error instanceof Error ? error.message : 'watch failed' })
      }
      await ops.firstSignal(run)
      const h = healthOf(run)
      run.reportedHealthy = h.healthy
      return reply({ watching: runs.has(runId), ...h, wake: wakePolicy(settings.wakeMode, h, settings.fallbackWakeupSeconds) })
    }
    if (input.action === 'unwatch') {
      await ops.unwatch(String(input.runId ?? ''))
      return reply({ watching: false })
    }
    if (input.action === 'claimed' || input.action === 'handback') {
      const run = typeof input.runId === 'string' ? runs.get(input.runId) : undefined
      if (!run) return reply({ ok: false, reason: 'run not watched: call watch first' })
      if (!isInstructionId(input.instructionId)) return reply({ ok: false, reason: 'instructionId must be a GUID' })
      ops.claim(run, input.action, input.instructionId)
      return reply({ ok: true, claimedInstructionId: run.claim.claimedInstructionId })
    }
    return reply({ error: 'action must be status, watch, unwatch, claimed or handback' })
  })

  // ---- slash commands -------------------------------------------------------------------------------------------

  on('command.run', { command: 'devorch-watch' }, async ($, e) => {
    const parsed = parseWatchArgs(e.args)
    if ('error' in parsed) return { text: parsed.error }
    if (parsed.list) {
      const rows = (statusObject().runs as Record<string, unknown>[]).map((r) => `${r.runId} ${r.baseUrl} rung ${r.rung} ${r.control ?? '-'} blockers ${(r.openBlockers as unknown[]).length}`)
      return { text: rows.length ? rows.join('\n') : 'Not watching a run. /devorch-watch <runId> [baseUrl]' }
    }
    if (!ops) return { text: 'DevOrch companion not started' }
    const allowed = canWatch([...runs.keys()], parsed.runId)
    if (!allowed.ok) return { text: `Not watching: ${allowed.reason}` }
    try {
      const run = await ops.watch(parsed.runId, parsed.baseUrl ?? undefined)
      return { text: `Watching ${run.entry.runId} on ${run.entry.baseUrl}` }
    } catch (error) {
      return { text: `Not watching: ${error instanceof Error ? error.message : 'watch failed'}` }
    }
  })

  on('command.run', { command: 'devorch-unwatch' }, async ($, e) => {
    const parsed = parseUnwatchArgs(e.args)
    if ('error' in parsed) return { text: parsed.error }
    const ids = parsed.all ? [...runs.keys()] : [parsed.runId]
    for (const id of ids) await ops?.unwatch(id)
    return { text: `Stopped watching ${ids.length} run(s)` }
  })

  on('command.run', { command: 'devorch-answer' }, async ($, e) => {
    const parsed = parseAnswerArgs(e.args)
    if (!parsed) return { text: 'usage: /devorch-answer <slug> <ref> <answer...>' }
    if (!ops) return { text: 'DevOrch companion not started' }
    return { text: await ops.answer(parsed.slug, parsed.blockerRef, parsed.answer) }
  })
}
