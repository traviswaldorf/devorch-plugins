---
name: step
argument-hint: "<runId>"
description: Processes the next instruction of a DevOrch run by dispatching its work to a devorch:step-worker subagent, keeping the main thread as a thin orchestrator; the companion mod wakes it for the next one (push) or /loop does (poll). TRIGGERS - devorch step, next devorch step, step this run, loop devorch run. USE WHEN - driving a DevOrch SDLC run one instruction at a time with /devorch:step <runId>, woken by the companion mod or repeated with /loop /devorch:step <runId>.
allowed-tools: mcp__plugin_devorch_api__get_next_instruction, mcp__plugin_devorch_api__apply_instruction_result, mcp__plugin_devorch_api__get_run_position, mcp__plugin_devorch_api__raise_blocker, mcp__devorch__companion, Bash(uv run scripts/worktree_manage.py *), Bash(uv run scripts/app_run.py *)
---

# DevOrch Step

`/devorch:step <runId>` processes the run's next instruction and, after the worker hands back, goes
straight on to the one after. Between instructions that can't start yet (a worker running, a `WAIT`), something
must wake the session again: the companion mod (**push**, realtime) or `/loop` with `ScheduleWakeup` (**poll**, timed).
The **Wake** check below decides which, on every firing.

**The main thread only orchestrates.** Never read stage docs, source files or the context bundle here, and never
call `get_context_for_instruction`. The worker does all of that. The only output per instruction is one status line.

**Tools.** Every DevOrch verb below (`get_next_instruction`, `apply_instruction_result`, `get_run_position`,
`raise_blocker`) is a tool of the DevOrch MCP server. This plugin bundles one, so the tools read
`mcp__plugin_devorch_api__<verb>`. If that server is absent, use the same verb from whichever DevOrch MCP
server this session has (for example `mcp__devorch-local-mcp__<verb>`); never mix two servers within one run, because
they may point at different backends. A `devorch` command you run yourself from Bash takes `--actor ai`, so it is
recorded as the agent's; one you hand the user to run (such as `devorch blocker answer`) does not.

## Wake: check it at the start of every firing

Exactly one thing wakes this session for a run. Before anything else in a firing (a launch, a wake from the mod, a
`/loop` tick or a worker's hand-back):

1. If the companion tool `mcp__devorch__companion` exists, call it with `{action: "watch", runId}`.
   Re-watching a watched run is cheap and answers at once. Add `baseUrl` only when this run lives on a different
   server from the resolved `apiBase` (`devorch config get apiBase --show-origin`), such as a worktree slot
   `http://localhost:8704`. Read **`wake.effective`** and `wake.fallbackWakeupSeconds` from the answer. Don't
   re-derive the policy from `healthy`.
2. No companion tool: treat it as `poll` with a 1800-second fallback.
3. Hold that value for the rest of the firing:

   | `wake.effective` | Who wakes the session | What this firing does about it |
   |---|---|---|
   | `push` | The companion mod: it submits `/devorch:step <runId>` within seconds of the run becoming actionable (a blocker answered, a lease freed or lapsed, the run finished), and hands the wake back once if it turns unhealthy. | **Schedule no wakeup, anywhere.** If this firing runs under `/loop`, stop the loop once (`ScheduleWakeup(stop: true)`) and say in one line that the companion owns the wake now; then carry on. |
   | `poll` | You: `ScheduleWakeup` under `/loop`. | Schedule the wakeups named below. If this firing is not under `/loop` (no `ScheduleWakeup` to call), start `/loop /devorch:step <runId>` at the point where a wakeup is due instead, and end the turn; its first firing picks up from there. |
   | `unavailable` | Nobody: `wakeMode` is `push` but the companion is unhealthy. | Finish a worker's hand-back if this firing is one (steps 5 to 7, so no work is lost), then launch nothing: print `wake.reason`, say `/devorch:step <runId>` resumes the run once the companion is fixed (or `wakeMode` is set to `auto`/`poll`), stop any `/loop` with `ScheduleWakeup(stop: true)`, and end the turn. |

"Schedule a wakeup" below always means: under `poll` only, as this table says.

## A firing has two halves

Subagents run asynchronously, so one instruction spans two turns: **launch** ends the turn, and the worker's
hand-back starts **finish**.

### Launch

1. **Don't double-dispatch.** If a worker launched in this session for this run hasn't handed back, launch nothing:
   don't fetch, don't launch a second worker and don't message the running one. This holds on a wake from the mod
   too: it wakes the session when a blocker on the instruction this session holds is answered, even while that
   instruction's worker is still running, and the worker's own hand-back then drives Finish. Under `poll`, schedule
   another fallback wakeup (`wake.fallbackWakeupSeconds`); under `push`, schedule nothing. End the turn.
2. Call `get_next_instruction(runId, driverId)` and branch on `control`. `driverId` is this session's id
   (`$CLAUDE_CODE_SESSION_ID`); use the same value on `apply_instruction_result`, because the instruction is leased
   to it. Pass the **bare** id: the envelope's `lease.holder` reads `driver:<id>` because the server adds that prefix
   itself, so sending the prefixed form back becomes `driver:driver:<id>` and every lease-checked call is a 409. If
   the tool doesn't offer `driverId`, omit it on both calls:

   | `control` | Action |
   |---|---|
   | `DONE` / `ESCALATE` / `ABORT` | PushNotification with the outcome and `reason`. Under `/loop`, `ScheduleWakeup(stop: true)`. Never self-heal. |
   | `WAIT` | Print the `reason` and open blockers from `get_run_position`. Under `push`, end the turn: the mod wakes the session when the run can move. Under `poll`, schedule a wakeup after `retryAfterSeconds` (else `wake.fallbackWakeupSeconds`). |
   | `CONTINUE` | If the companion tool exists, call it with `{action: "claimed", runId, instructionId}` (the envelope's `instructionId`), then go to 3. The claim tells the mod this lease is the session's own, so answering a blocker raised on it wakes the session. |

   The answer to a blocker can be given from here with `/devorch-answer <slug> <ref> <answer>` (mod) or
   `devorch blocker answer <slug> <ref> --text ...` (CLI); never answer it yourself.

   Re-fetching an instruction that was dispatched but never applied returns the same `instructionId`, so resuming
   after a crash is safe.
3. **Worktree, when `node.stage` is `implement`, `review` or `qa`.**
   - **In the DevOrch workspace** (the project root has `scripts/worktree_manage.py` and `scripts/app_run.py`): the
     worktree is named after `inputs.workItemSlug`. Check `uv run scripts/worktree_manage.py list`; if it's absent,
     run `uv run scripts/worktree_manage.py create <slug>` (or `create <slug> --start` to create and start it in one
     command). Then run `uv run scripts/app_run.py up --wait` from the worktree root (exit 4 = started but not healthy
     in time; 5 = its port is held by another checkout's process). Pass its absolute path to the worker.
   - **Anywhere else**, pass `none`: the worker works in the current checkout.

   For earlier stages, pass `none`.
4. Launch one `devorch:step-worker` subagent (this plugin's worker agent) with this prompt, then end the turn:

   ```
   runId: <runId>
   instructionId: <instructionId>
   worktree: <absolute path | none>
   driverId: <this session's bare id, never the "driver:"-prefixed lease holder>
   Do this step's work, including writing its stage documents under sdlc/<slug>/ and any code changes, then
   return the result JSON. Parse slot JSON locally before put_step_output; if a store call fails, report its
   exact text, and don't blame driverId for an opaque failure.
   ```

   Under `poll`, first schedule a fallback wakeup of `wake.fallbackWakeupSeconds` (1800 by default) in case the
   worker never hands back. Under `push`, schedule nothing: the mod wakes the session if the worker's instruction
   lease lapses without a result.

### Finish (on the worker's hand-back)

5. Parse the hand-back as one JSON object. If it doesn't parse, or step 6 rejects it, relaunch the worker once with
   the error appended. On a second failure, call `raise_blocker` with type `error` and treat the run as `WAIT`.
6. Call `apply_instruction_result(runId, instructionId, <result JSON>, driverId)`. Then, if the companion tool exists,
   call it with `{action: "handback", runId, instructionId}`, so the mod stops treating that lease as the session's.
7. Print one line and nothing else about the work, such as `qa/execute DONE (pass 1) - 12/12 passed`.
8. **Don't wait for a wakeup, with or without `/loop`: go straight back to Launch step 2 in this same turn** and fetch
   the next instruction (after the Wake check, unless it said `unavailable`). A `CONTINUE` launches the next worker
   now; a `WAIT` or terminal `control` is handled by the step 2 table. This is what keeps a push-driven run snappy:
   the mod only has to wake the session when the run was waiting on something outside it.

## Anti-patterns

- Doing a step's work in the main thread.
- Echoing the worker's result, or a summary longer than the status line.
- Scheduling a wakeup, or starting `/loop`, while `wake.effective` is `push`: two wake owners fire twice.
- Skipping `claimed` after a `CONTINUE` fetch: a blocker answered on that instruction then never wakes the session.
- Polling when `wake.effective` is `unavailable`: the user chose push only.
- Merging to `main` during a run. That's a human confirmation after `DONE`.
