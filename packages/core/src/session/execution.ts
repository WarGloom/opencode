export * as SessionExecution from "./execution.js"

import { Cause, Context, Effect, Exit, Layer } from "effect"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { Job } from "../job.js"
import { Instance } from "../instance/service.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { SessionEvent } from "./event.js"
import { SessionInbox } from "./inbox.js"
import { SubagentReport } from "./execution/subagent-report.js"
import { SessionRunCoordinator } from "./run-coordinator.js"
import { SessionRunner } from "./runner/index.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"
import { toSessionError } from "./to-session-error.js"
import { SessionInterruptJournal } from "./interrupt-journal.js"
import { SessionMessage } from "./message.js"
import { KV } from "../kv.js"

export interface Interface {
  /** Snapshots active execution owned by this process. */
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  /** Checks process-local ownership, including interruption cleanup and terminal settlement. */
  readonly isActive: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  /** Starts execution while idle or joins the active execution. */
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
  /** Registers newly recorded work. Repeated wakeups may coalesce. */
  readonly wake: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /**
   * The durable sequence where the Session's current busy period started, if one is bound.
   * Sequence-bounded lookups use it to find only work created by this period.
   */
  readonly periodStartSeq: (sessionID: SessionSchema.ID) => Effect.Effect<number | undefined>
  /**
   * Interrupt active work owned by this process. Idle interruption is a no-op. Resolves once
   * the interruption is accepted; cleanup settles asynchronously in the execution fiber.
   * Returns whether an active execution was interrupted. Compose with `awaitIdle` when
   * settlement matters.
   */
  readonly interrupt: (
    sessionID: SessionSchema.ID,
    options?: {
      readonly resume?: boolean
    },
  ) => Effect.Effect<boolean>
  /** Resolves once this process owns no active execution for the Session. Returns immediately when idle and never starts work. */
  readonly awaitIdle: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly recover: (input: { readonly sessionID: SessionSchema.ID; readonly owner: SessionInterruptJournal.Owner }, callback: (boundaryID: SessionMessage.ID) => Effect.Effect<boolean, unknown>) => Effect.Effect<boolean, unknown>
  readonly closeRecovery: (owner: SessionInterruptJournal.Owner) => Effect.Effect<void>
  readonly recovery: (sessionID: SessionSchema.ID, generation?: string) => Effect.Effect<"committed" | undefined, Error>
  readonly recoveryAdmission: (sessionID: SessionSchema.ID, boundaryID: SessionMessage.ID, owner: SessionInterruptJournal.Owner) => Effect.Effect<SessionInterruptJournal.Admission | undefined>
}

/** Routes execution from a Session ID to its selected instance's runner. */
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionExecution") {}

type InterruptReason = "user" | "shutdown" | `recovery:${string}`

export function terminal(exit: Exit.Exit<void, SessionRunner.RunError>, reason?: InterruptReason) {
  if (Exit.isSuccess(exit)) return { type: "succeeded" as const }
  if (Cause.hasInterrupts(exit.cause)) return { type: "interrupted" as const, reason: reason ?? "shutdown" }
  return { type: "failed" as const, error: toSessionError(Cause.squash(exit.cause)) }
}

/** Process-local execution: drains run in this process using the selected instance. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const instances = yield* Instance.Service
    const bus = yield* Bus.Service
    const jobs = yield* Job.Service
    const inbox = yield* SessionInbox.Service
    const journal = yield* SessionInterruptJournal.make(yield* KV.Service)
    const db = (yield* Database.Service).db
    const reportLifecycle = <A>(sessionID: SessionSchema.ID, effect: Effect.Effect<A>) =>
      effect.pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("Failed to publish Session execution lifecycle", cause).pipe(
                Effect.annotateLogs({ sessionID }),
              ),
        ),
        Effect.asVoid,
      )
    // Write-ahead claim: starting records the durable intent that a turn is in flight, in the same
    // transaction as the started event. Terminals release it — except shutdown interruption, which
    // preserves the claim so the next server start resumes the turn. A claim that survives with no
    // terminal is the signature of a process that died without teardown (crash, SIGKILL, eviction);
    // recovery is a property of the database, never of a shutdown hook that may not run.
    const claimOnCommit = (sessionID: SessionSchema.ID) => ({
      commit: () => store.claim(sessionID),
    })
    const releaseOnCommit = (sessionID: SessionSchema.ID) => ({ commit: () => store.release(sessionID) })
    // The report coordinator is built first so the run coordinator's hooks can use it, while its
    // wake and draining dependencies bind late to the coordinator the hooks belong to.
    const holder: {
      coordinator?: SessionRunCoordinator.Coordinator<SessionSchema.ID, SessionRunner.RunError, InterruptReason>
    } = {}
    const subagentReport = SubagentReport.make({
      store,
      jobs,
      inbox,
      wake: (sessionID) =>
        Effect.suspend(() => (holder.coordinator ? holder.coordinator.wake(sessionID) : Effect.void)),
      draining: Effect.suspend<ReadonlySet<SessionSchema.ID>, never, never>(() =>
        holder.coordinator ? holder.coordinator.draining : Effect.succeed(new Set<SessionSchema.ID>()),
      ),
    })
    // Why a Session's execution is being interrupted, read from the coordinator once it exists.
    let interruption: (sessionID: SessionSchema.ID) => InterruptReason | undefined = () => undefined
    const reconcile = yield* Effect.cached(Effect.forEach(journal.abandoned(), (attempt) => Effect.gen(function* () {
      const sessionID = SessionSchema.ID.make(attempt.record.sessionID)
      yield* bus.publish(SessionEvent.Execution.Failed, { sessionID, error: toSessionError(new Error("Recovery abandoned by host restart")) }, {
        commit: () => journal.finish(attempt, "failed", "Recovery abandoned by host restart").pipe(Effect.andThen(store.release(sessionID))),
      })
    }), { discard: true }))
    const drain = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      force: boolean,
      continuation?: SessionRunner.Continuation,
      promotable: SessionInbox.Promotable = "input",
      stepped = false,
    ): Effect.fn.Return<void, SessionRunner.RunError> {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
      const result = yield* SessionRunner.Service.use((runner) =>
        runner.drain({
          sessionID,
          force,
          continuation,
          promotable,
          stepped,
          interruption: () => {
            const reason = interruption(sessionID)
            if (reason === undefined || reason === "shutdown") return reason
            return "user"
          },
        }),
      ).pipe(
        instances.provide(session),
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
        ),
      )
      return yield* SessionRunner.DrainResult.$match(result, {
        Complete: () => Effect.void,
        Moved: (result) => drain(sessionID, false, result.continuation, promotable, result.stepped),
        Reloaded: (result) => drain(sessionID, result.force, result.continuation, promotable, result.stepped),
      })
    })
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError, InterruptReason>({
      started: (sessionID) =>
        reportLifecycle(
          sessionID,
          Effect.gen(function* () {
            // Bind before the started publication yields to SQLite so a cancel arriving during
            // that window still matches this generation.
            const before = yield* jobs.currentGeneration(sessionID)
            const event = yield* bus.publish(SessionEvent.Execution.Started, { sessionID }, claimOnCommit(sessionID))
            const bound = before?.running ? before : yield* jobs.currentGeneration(sessionID)
            subagentReport.started(sessionID, {
              startedSeq: event.durable.seq,
              boundGeneration: bound?.running ? bound.generation : undefined,
            })
          }),
        ),
      drain: (sessionID, force, promotable) => drain(sessionID, force, undefined, promotable),
      // One terminal observation per busy period, covering every coalesced drain.
      settled: (sessionID, exit, reason) =>
        reportLifecycle(
          sessionID,
          Effect.gen(function* () {
            const outcome = terminal(exit, reason)
            if (outcome.type === "interrupted" && outcome.reason === "shutdown") {
              subagentReport.clear(sessionID)
              // Shutdown keeps the claim and the running Job row for restart continuity.
              yield* bus.publish(SessionEvent.Execution.Interrupted, { sessionID, reason: "shutdown" })
              return
            }
            const attempt = journal.get(sessionID)
            const recovering = outcome.type === "interrupted" && outcome.reason === `recovery:${attempt?.record.id}`
            if (recovering && attempt?.record.phase === "held") {
              yield* bus.publish(SessionEvent.Execution.Interrupted, { sessionID, reason: "user" }, releaseOnCommit(sessionID))
              return
            }
            const settledOutcome = recovering && attempt?.record.phase === "failed"
              ? { type: "failed" as const, error: toSessionError(new Error(attempt.record.error ?? "Recovery abandoned")) }
              : outcome.type === "interrupted" ? { type: "interrupted" as const, reason: "user" as const } : outcome
            // Claim the Job generation before cancelling it so the settlement commit owns its outbox row.
            const settlement = yield* subagentReport.prepare(sessionID, settledOutcome)
            if (settledOutcome.type === "interrupted") yield* jobs.cancel(sessionID)
            yield* publishTerminal(bus, sessionID, settledOutcome, settlement.commit)
            // Post-commit delivery is best effort: a retained outbox marker is recovered on the
            // next restart, and a delivery defect must not fail the settled hook.
            yield* settlement.deliver.pipe(
              Effect.ignoreCause({ log: "Error", message: "Subagent report delivery failed" }),
            )
          }),
        ),
    })
    holder.coordinator = coordinator

    interruption = coordinator.interruption
    const failRecovery = (attempt: SessionInterruptJournal.Attempt, error: string) => SessionInbox.serialized(SessionSchema.ID.make(attempt.record.sessionID), Effect.gen(function* () {
      if (attempt.record.phase !== "held") return
      const sessionID = SessionSchema.ID.make(attempt.record.sessionID)
      const [newest] = yield* store.messages({ sessionID, order: "desc", limit: 1 }).pipe(Effect.orDie)
      if (newest?.id === attempt.record.boundaryID && !(yield* coordinator.isActive(sessionID))) {
        const outcome = { type: "failed" as const, error: toSessionError(new Error(error)) }
        const settlement = yield* subagentReport.prepare(sessionID, outcome)
        yield* publishTerminal(bus, sessionID, outcome, settlement.commit)
        yield* settlement.deliver.pipe(Effect.ignoreCause({ log: "Error", message: "Subagent report delivery failed" }))
      }
      yield* journal.finish(attempt, "failed", error)
    }))

    return Service.of({
      active: reconcile.pipe(Effect.andThen(coordinator.active)),
      isActive: coordinator.isActive,
      periodStartSeq: subagentReport.periodStartSeq,
      interrupt: (sessionID, options) =>
        Effect.gen(function* () {
          const held = yield* SessionInbox.serialized(sessionID, Effect.gen(function* () {
            const attempt = journal.get(sessionID)
            if (attempt?.record.phase !== "held") return undefined
            yield* journal.finish(attempt, "cancelled", "Recovery revoked by cancellation")
            return attempt
          }))
          if (held) {
            yield* jobs.cancel(sessionID, held.record.generation ?? undefined)
            yield* journal.signal(held)
          }
          const interrupted = yield* coordinator.interrupt(sessionID, "user")
          if (!options?.resume) return interrupted
          // Resume steering input and between-turn control work from the interrupted
          // intent. Queued next-turn prompts stay parked: a steer-scoped drain never
          // promotes them, and a control item behind a queued prompt waits its turn.
          // Interruption acknowledges before cleanup settles, so this wake usually lands
          // on the stopping execution's doorbell and starts the successor at settle.
          // Reading the inbox concurrently with the dying drain is safe: delivery consumes
          // rows inside uninterruptible publications, so a steer row is either still
          // promotable here or was fully delivered and needs no resumption.
          const next = yield* SessionInbox.nextPromotable(db, sessionID, "input")
          if (next === undefined) return interrupted
          if (next.delivery === "steer" || next.type === "compaction" || next.type === "move")
            yield* coordinator.wake(sessionID, "steer")
          return interrupted
        }),
      resume: (sessionID) => reconcile.pipe(Effect.andThen(coordinator.run(sessionID))),
      wake: (sessionID) => reconcile.pipe(Effect.andThen(coordinator.wake(sessionID))),
      awaitIdle: coordinator.awaitIdle,
      recover: (input, callback) => Effect.acquireUseRelease(
        SessionInbox.serialized(input.sessionID, Effect.gen(function* () {
          const captured = yield* coordinator.capture(input.sessionID)
          if (!captured) return undefined
          const info = yield* jobs.get(input.sessionID)
          const attempt = yield* journal.begin(input.sessionID, input.owner, info?.status === "running" ? info.generation : undefined)
          if (!attempt) return undefined
          const [watermark] = yield* store.messages({ sessionID: input.sessionID, order: "desc", limit: 1 })
          if (!(yield* captured.interrupt(`recovery:${attempt.record.id}`))) {
            yield* journal.finish(attempt, "failed", "Recovery did not capture an active execution")
            yield* journal.forget(attempt)
            return undefined
          }
          return { attempt, watermark, settled: captured.settled }
        })),
        (captured) => Effect.gen(function* () {
          if (!captured) return false
          yield* captured.settled
          const boundary = yield* SessionInbox.serialized(input.sessionID, Effect.gen(function* () {
            if (captured.attempt.record.phase !== "held") return undefined
            const [settled] = yield* store.messages({ sessionID: input.sessionID, order: "asc", type: "idle", limit: 1,
              ...(captured.watermark ? { cursor: { id: captured.watermark.id, direction: "next" as const } } : {}) })
            if (settled?.type !== "idle" || settled.outcome !== "interrupted") {
              yield* journal.finish(captured.attempt, "settled", "Captured execution settled without interruption")
              return undefined
            }
            yield* journal.boundary(captured.attempt, settled.id)
            return settled.id
          }))
          if (!boundary) return false
          yield* callback(boundary)
          return captured.attempt.record.phase === "committed"
        }),
        (captured, exit) => captured ? captured.settled.pipe(Effect.andThen(failRecovery(captured.attempt, Exit.isFailure(exit)
          ? `Recovery failed: ${Cause.pretty(exit.cause)}` : "Recovery declined without an admitted continuation"))) : Effect.void,
      ),
      closeRecovery: (owner) => Effect.forEach(
        journal.all().filter((attempt) => attempt.record.pluginID === owner.pluginID && attempt.record.lifetime === owner.lifetime),
        (attempt) => failRecovery(attempt, "Recovery abandoned by plugin disposal"), { discard: true }),
      recovery: (sessionID, generation) => reconcile.pipe(Effect.andThen(journal.wait(sessionID, generation))),
      recoveryAdmission: (sessionID, boundaryID, owner) => Effect.sync(() => {
        const attempt = journal.get(sessionID)
        if (!attempt || attempt.record.boundaryID !== boundaryID || attempt.record.pluginID !== owner.pluginID || attempt.record.lifetime !== owner.lifetime) return undefined
        return {
          check: Effect.gen(function* () {
            const info = yield* jobs.get(sessionID)
            return attempt.record.phase === "held" && (attempt.record.generation === null || (info?.status === "running" && info.generation === attempt.record.generation))
          }),
          commit: () => journal.commit(attempt),
          signal: journal.committed(attempt),
        }
      }),
    })
  }),
)

/** Publishes the terminal event with the settlement's atomic commit. */
function publishTerminal(
  bus: Bus.Interface,
  sessionID: SessionSchema.ID,
  outcome: Exclude<ReturnType<typeof terminal>, { readonly type: "interrupted" }> | { readonly type: "interrupted"; readonly reason: "user" },
  commit: (seq: number) => Effect.Effect<void>,
) {
  if (outcome.type === "succeeded") return bus.publish(SessionEvent.Execution.Succeeded, { sessionID }, { commit })
  if (outcome.type === "interrupted") {
    return bus.publish(SessionEvent.Execution.Interrupted, { sessionID, reason: outcome.reason }, { commit })
  }
  return bus.publish(SessionEvent.Execution.Failed, { sessionID, error: outcome.error }, { commit })
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [SessionStore.node, Instance.node, Bus.node, Database.node, Job.node, SessionInbox.node, KV.node],
})

/** Low-level compatibility layer for callers that only need durable Session recording. */
export const noop = Service.of({
    active: Effect.succeed(new Set()),
    isActive: () => Effect.succeed(false),
    resume: () => Effect.void,
    wake: () => Effect.void,
    periodStartSeq: () => Effect.succeed(undefined),
    interrupt: () => Effect.succeed(false),
    awaitIdle: () => Effect.void,
    recover: () => Effect.succeed(false),
    closeRecovery: () => Effect.void,
    recovery: () => Effect.succeed(undefined),
    recoveryAdmission: () => Effect.succeed(undefined),
})
export const noopLayer = Layer.succeed(Service, noop)
