export * as SessionExecution from "./execution.js"

import { Cause, Context, Effect, Exit, Layer } from "effect"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { Job } from "../job.js"
import { Instance } from "../instance/service.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { SessionEvent } from "./event.js"
import { SessionRunCoordinator } from "./run-coordinator.js"
import { SessionRunner } from "./runner/index.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"
import { toSessionError } from "./to-session-error.js"
import { SessionInbox } from "./inbox.js"
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
    const releaseOnCommit = (sessionID: SessionSchema.ID) => ({
      commit: () => store.release(sessionID),
    })
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
        runner.drain({ sessionID, force, continuation, promotable, stepped }),
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
          bus.publish(SessionEvent.Execution.Started, { sessionID }, claimOnCommit(sessionID)),
        ),
      drain: (sessionID, force, promotable) => drain(sessionID, force, undefined, promotable),
      // One terminal observation per busy period, covering every coalesced drain.
      settled: (sessionID, exit, reason) =>
        reportLifecycle(
          sessionID,
          Effect.gen(function* () {
            const outcome = terminal(exit, reason)
            if (outcome.type === "succeeded") {
              yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID }, releaseOnCommit(sessionID))
              return
            }
            if (outcome.type === "interrupted") {
              // Deliberate stops release the claim; shutdown keeps it for restart continuity.
              const attempt = journal.get(sessionID)
              if (outcome.reason === `recovery:${attempt?.record.id}` && attempt?.record.phase === "failed") {
                yield* bus.publish(SessionEvent.Execution.Failed, { sessionID, error: toSessionError(new Error(attempt.record.error ?? "Recovery abandoned")) }, releaseOnCommit(sessionID))
                return
              }
              const held = outcome.reason === `recovery:${attempt?.record.id}` && attempt?.record.phase !== "cancelled"
              if (outcome.reason !== "shutdown" && !held) yield* jobs.cancel(sessionID)
              yield* bus.publish(
                SessionEvent.Execution.Interrupted,
                { sessionID, reason: outcome.reason === "shutdown" ? "shutdown" : "user" },
                outcome.reason === "shutdown" ? undefined : releaseOnCommit(sessionID),
              )
              return
            }
            yield* bus.publish(
              SessionEvent.Execution.Failed,
              {
                sessionID,
                error: outcome.error,
              },
              releaseOnCommit(sessionID),
            )
          }),
        ),
    })

    const failRecovery = (attempt: SessionInterruptJournal.Attempt, error: string) => SessionInbox.serialized(SessionSchema.ID.make(attempt.record.sessionID), Effect.gen(function* () {
      if (attempt.record.phase !== "held") return
      yield* journal.finish(attempt, "failed", error)
      const sessionID = SessionSchema.ID.make(attempt.record.sessionID)
      const [newest] = yield* store.messages({ sessionID, order: "desc", limit: 1 }).pipe(Effect.orDie)
      if (newest?.id === attempt.record.boundaryID && !(yield* coordinator.isActive(sessionID)))
        yield* bus.publish(SessionEvent.Execution.Failed, { sessionID, error: toSessionError(new Error(error)) }, releaseOnCommit(sessionID))
    }))

    return Service.of({
      active: reconcile.pipe(Effect.andThen(coordinator.active)),
      isActive: coordinator.isActive,
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

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [SessionStore.node, Instance.node, Bus.node, Database.node, Job.node, KV.node],
})

/** Low-level compatibility layer for callers that only need durable Session recording. */
export const noop = Service.of({
    active: Effect.succeed(new Set()),
    isActive: () => Effect.succeed(false),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.succeed(false),
    awaitIdle: () => Effect.void,
    recover: () => Effect.succeed(false),
    closeRecovery: () => Effect.void,
    recovery: () => Effect.succeed(undefined),
    recoveryAdmission: () => Effect.succeed(undefined),
})
export const noopLayer = Layer.succeed(Service, noop)
