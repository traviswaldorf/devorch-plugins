/**
 * The `$.devorch` noun the DevOrch companion mod adds in its `engine.create` step (design-L0 D9), and the session
 * state it keeps (D10). Another plugin that lists `devorch` under "dependencies" reads these types.
 *
 * The noun is subscribe and read only: a plugin can observe the platform event envelopes of the runs this session
 * watches, but cannot watch, wake or answer through it (only the companion mod submits a wake, CC-4).
 */

/** One platform event envelope (v1) as `devorch run watch` prints it: ids, refs and enums only. */
export type DevorchEnvelope = {
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

export type DevorchRunStatus = {
  runId: string
  baseUrl: string
  rung: 1 | 2 | 3 | 4
  ladderReason: string
  control: string | null
  reasonCode: string | null
  leaseHeld: boolean
  openBlockers: { ref: string; kind: string }[]
  pendingWake: boolean
}

/** Who wakes an interactive run: `push` the companion, `poll` the skill's /loop + ScheduleWakeup, `unavailable`
 * wakeMode push with an unhealthy companion. */
export type DevorchWakePolicy = {
  mode: 'auto' | 'push' | 'poll'
  effective: 'push' | 'poll' | 'unavailable'
  owner: 'companion' | 'skill' | 'none'
  fallbackWakeupSeconds: number
  reason: string
}

export type DevorchStatus = {
  healthy: boolean
  reason?: string
  wake: DevorchWakePolicy
  config: {
    wakeMode: 'auto' | 'push' | 'poll'
    fallbackWakeupSeconds: number
    longPollSeconds: number
    sources: Record<'wakeMode' | 'fallbackWakeupSeconds' | 'longPollSeconds', 'env' | 'option' | 'default'>
    warnings: string[]
  }
  cli: { ok: boolean; version: string | null; path: string | null }
  stopHookArmed: boolean
  wakeBroken: boolean
  runs: DevorchRunStatus[]
}

export type Devorch = {
  /**
   * Calls `handler` for every envelope of a watched run whose type matches `pattern`: an exact type
   * (`run.position`), a prefix wildcard (`blocker.*`) or `*`. A throwing handler never stops the others.
   * @returns a function that removes the handler
   */
  on: (pattern: string, handler: (envelope: DevorchEnvelope) => void | Promise<void>) => () => void
  /** The latest `run.position` envelope of a watched run, or null. */
  latest: (runId: string) => DevorchEnvelope | null
  /** The same answer as the `companion` tool's (`mcp__devorch__companion`) `status` action. */
  status: () => DevorchStatus
}

export type DevorchWatchEntry = { runId: string; baseUrl: string; lastToken?: string; addedAt: number }

declare module 'claude-code' {
  interface EngineInterface {
    devorch: Devorch
  }
  interface PluginState {
    'devorch': { watched: { runs: DevorchWatchEntry[] } }
  }
}
