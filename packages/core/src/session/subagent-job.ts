export * as SubagentJob from "./subagent-job.js"

import { Context, Deferred, Effect, Exit, Layer, Scope } from "effect"
import { Node } from "@opencode/util/effect/app-node"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { Job } from "../job.js"
import { Bus } from "../bus.js"
import { Session } from "../session.js"
import { SessionExecution } from "./execution.js"
import { SubagentCompletion } from "./subagent-completion.js"
import { SubagentAdmissionStore } from "./subagent-admission-store.js"
import { SessionMessage } from "./message.js"
import { SessionEvent } from "./event.js"
import { Event } from "@opencode/schema/event"

type Recovery = Extract<Job.Recovery, { kind: "subagent" }>

export interface Interface {
  readonly start: (recovery: Recovery) => Effect.Effect<Job.Info>
  background: (recovery: Recovery) => Effect.Effect<void>
  notify: (recovery: Recovery, startedAt: number) => Effect.Effect<void>
  current: (childSessionID: Session.ID) => Effect.Effect<Job.Info | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentJob") {}

export function start(
  jobs: Job.Interface,
  execution: SessionExecution.Interface,
  recovery: Recovery,
  notificationID?: Job.Background["notificationID"],
) {
  const id = recovery.childSessionID
  return jobs.start({
    id,
    type: "subagent",
    title: recovery.description,
    metadata: notificationID === undefined ? {} : undefined,
    recovery,
    notificationID,
    background: true,
    run: execution.resume(id).pipe(
      // Only an explicit caller cancel releases the child's claim. A server shutdown
      // interrupts this job but must leave the child resumable on the next start.
      Effect.onInterrupt(() =>
        jobs.isCancelled(id).pipe(Effect.flatMap((cancelled) => (cancelled ? execution.interrupt(id) : Effect.void))),
      ),
      Effect.as(""),
    ),
  })
}

const make = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const jobs = yield* Job.Service
  const admissions = yield* SubagentAdmissionStore.Service
  const execution = yield* SessionExecution.Service
  const bus = yield* Bus.Service
  const scope = yield* Scope.Scope
  // Jobs and their completion observers outlive the plugin that launched them.
  // Fork with the global context too, rather than retaining the caller's location.
  const context = yield* Effect.context<never>()
  // One observer per job generation, including continuations of the same child.
  const notifications = new Set<string>()
  const ending = new Set<string>()
  const revisions = new Map<string, number>()
  const current = Effect.fn(function* (childSessionID: Session.ID) {
    const info = yield* jobs.get(childSessionID)
    if (info === undefined) return undefined
    if (info.status !== "running") {
      ending.delete(info.generation)
      return undefined
    }
    if (!ending.has(info.generation)) return info
    yield* jobs.wait({ id: childSessionID, generation: info.generation })
    return undefined
  })

  const notify = Effect.fn("SubagentJob.notify")(function* (recovery: Recovery, startedAt: number) {
    const key = `${recovery.childSessionID}:${recovery.generation ?? startedAt}`
    if (notifications.has(key)) return
    notifications.add(key)
    yield* Effect.gen(function* () {
      const info = (yield* jobs.wait({ id: recovery.childSessionID, generation: recovery.generation })).info
      if (info) {
        ending.delete(info.generation)
        // The owning plugin's cancel marks its admissions before it stops the job. That caller already has the
        // outcome, so it is recorded on the Job and admission without a parent completion wake.
        let ownerCancelled = false
        if (recovery.pluginID !== undefined)
          yield* admissions.serialized(Effect.gen(function* () {
            const entries = yield* admissions.list(recovery.pluginID)
            for (const entry of entries) {
              if (entry.childSessionID !== recovery.childSessionID || entry.generation !== info.generation) continue
              if (entry.ownerCancelled === true && info.status === "cancelled") ownerCancelled = true
              yield* admissions.put({ ...entry, status: info.status, output: info.output, error: info.error })
            }
          }))
        if (!ownerCancelled) yield* SubagentCompletion.deliver(sessions, jobs, { ...info, recovery })
      }
    }).pipe(
      Effect.ensuring(Effect.sync(() => notifications.delete(key))),
      // The global context drops the caller's span annotations; delivery is the parent session's work.
      Effect.annotateSpans("session.id", recovery.parentSessionID),
      Effect.forkIn(scope, { startImmediately: true }),
      Effect.setContext(context),
    )
  })

  const startGeneration = Effect.fn(function* (recovery: Recovery) {
    const active = yield* current(recovery.childSessionID)
    if (active !== undefined) revisions.set(active.generation, (revisions.get(active.generation) ?? 0) + 1)
    return yield* jobs.start({
          id: recovery.childSessionID,
          type: "subagent",
          title: recovery.description,
          metadata: {},
          recovery,
          background: recovery.pluginID === undefined,
          generation: recovery.generation,
          notificationID: recovery.generation === undefined ? undefined : SessionMessage.ID.make(`msg_subagent_${recovery.generation}`),
          durable: recovery.pluginID !== undefined,
          accept: recovery.pluginID === undefined ? undefined : (info) => bus.publish(SessionEvent.ChildAccepted, {
            sessionID: recovery.parentSessionID,
            childSessionID: recovery.childSessionID,
            generation: info.generation,
          }, { id: Event.ID.make(`evt_subagent_accepted_${info.generation}`) }).pipe(Effect.asVoid),
          run: Effect.gen(function* () {
            const info = yield* jobs.get(recovery.childSessionID)
            const generation = info?.generation ?? recovery.generation
            const revision = generation === undefined ? 0 : revisions.get(generation) ?? 0
            const abandoned = yield* execution.recovery(recovery.childSessionID, generation).pipe(Effect.result)
            if (recovery.pluginID !== undefined && abandoned._tag === "Failure") return yield* Effect.fail(abandoned.failure)
            const resumed = abandoned._tag === "Failure"
              ? Exit.fail(abandoned.failure)
              : yield* sessions.resume(recovery.childSessionID).pipe(Effect.exit)
            let recovered = abandoned._tag === "Success" && abandoned.success === "committed"
            while (true) {
              const started = yield* Deferred.make<void>()
              const unsubscribe = yield* bus.listen((event) =>
                event.type === SessionEvent.Execution.Started.type && event.durable?.aggregateID === recovery.childSessionID
                  ? Deferred.succeed(started, undefined).pipe(Effect.asVoid)
                  : Effect.void,
              )
              const result = yield* Effect.gen(function* () {
                yield* sessions.wait(recovery.childSessionID)
                const recoveryResult = yield* execution.recovery(recovery.childSessionID, generation).pipe(Effect.result)
                recovered = (recoveryResult._tag === "Success" && recoveryResult.success === "committed") || recovered
                const result = yield* admissions.serialized(Effect.gen(function* () {
                if (yield* execution.isActive(recovery.childSessionID)) return undefined
                const messages = yield* sessions.messages({ sessionID: recovery.childSessionID, order: "desc", limit: 20 })
                const assistant = messages.find((message) => message.type === "assistant")
                if (recovery.pluginID !== undefined && recoveryResult._tag === "Failure") return Exit.fail(recoveryResult.failure)
                if (recoveryResult._tag === "Failure") {
                  const child = yield* sessions.get(recovery.childSessionID)
                  if (child.outcome === "failed") return Exit.fail(assistant?.error ?? recoveryResult.failure)
                  if (child.outcome !== "succeeded") return "await-start" as const
                  recovered = true
                }
                const info = yield* jobs.get(recovery.childSessionID)
                if (info !== undefined) ending.add(info.generation)
                if (!recovered && Exit.isFailure(resumed) && (generation === undefined || (revisions.get(generation) ?? 0) === revision))
                  return Exit.failCause(resumed.cause)
                const child = yield* sessions.get(recovery.childSessionID)
                if (child.outcome === "failed" || child.outcome === "interrupted")
                  return Exit.fail(assistant?.error ?? new Error(`Subagent execution ${child.outcome}`))
                if (recovery.pluginID !== undefined) return Exit.succeed(SubagentCompletion.text(assistant))
                return Exit.succeed("")
                }))
                if (result === "await-start") {
                  yield* Deferred.await(started)
                  return undefined
                }
                return result
              }).pipe(Effect.ensuring(unsubscribe))
              if (result === undefined) continue
              if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause)
              return result.value
            }
          }).pipe(Effect.onInterrupt(() => jobs.isCancelled(recovery.childSessionID).pipe(
            Effect.flatMap((cancelled) => cancelled ? execution.interrupt(recovery.childSessionID) : Effect.void),
          )), Effect.onExit(() => Effect.gen(function* () {
            const info = yield* jobs.get(recovery.childSessionID)
            if (info !== undefined) ending.add(info.generation)
          }))),
        }).pipe(
          Effect.tap(() => recovery.pluginID === undefined ? Effect.void : execution.wake(recovery.childSessionID)),
          Effect.tap((info) => jobs.wait({ id: info.id, generation: info.generation }).pipe(
            Effect.tap(() => Effect.sync(() => {
              ending.delete(info.generation)
              revisions.delete(info.generation)
            })),
            Effect.forkIn(scope, { startImmediately: true }),
          )),
        )
  })
  return Service.of({
    start: (recovery) => (recovery.pluginID === undefined ? admissions.serialized(startGeneration(recovery)) : startGeneration(recovery)).pipe(Effect.setContext(context)),
    current,
    background: Effect.fn("SubagentJob.background")(function* (recovery: Recovery) {
      const info = yield* jobs.background(recovery.childSessionID)
      if (info) yield* notify(recovery, info.started_at)
    }),
    notify,
  })
})

export const layer = Layer.effect(Service, make)

export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.global> = Node.makeGlobalNode({
  service: Service,
  layer,
  deps: [Session.node, Job.node, SubagentAdmissionStore.node, SessionExecution.node, Bus.node],
})
