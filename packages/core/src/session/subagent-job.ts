export * as SubagentJob from "./subagent-job.js"

import { Cause, Clock, Context, Deferred, Duration, Effect, Exit, Layer, Option, Scope } from "effect"
import { Node } from "@opencode/util/effect/app-node"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { Job } from "../job.js"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { Config } from "../config.js"
import { Instance } from "../instance/service.js"
import { Session } from "../session.js"
import { SessionExecution } from "./execution.js"
import { SessionStore } from "./store.js"
import { SubagentCompletion } from "./subagent-completion.js"
import { SubagentAdmissionStore } from "./subagent-admission-store.js"
import { SubagentSteerBinding } from "./subagent-steer-binding.js"
import { SessionMessage } from "./message.js"
import { SessionEvent } from "./event.js"
import { SessionInbox } from "./inbox.js"
import { SessionBackground } from "./background.js"
import { Event } from "@opencode/schema/event"

type Recovery = Extract<Job.Recovery, { kind: "subagent" }>
type Admitted = { readonly sessionID: Session.ID; readonly ids: Set<SessionMessage.ID> }
type Outcome = Pick<Job.Info, "generation" | "status" | "output" | "error">

// The sender reads a closed generation's outcome, so what was not delivered goes where its result or error text goes.
const annotate = <T extends Outcome>(info: T, note: string): T =>
  info.status === "completed"
    ? { ...info, output: `${info.output ?? SubagentCompletion.NO_TEXT}\n\n${note}` }
    : {
        ...info,
        error: `${info.error ?? (info.status === "error" ? "Subagent failed" : "Subagent cancelled")}\n\n${note}`,
      }

export interface Interface {
  /** `promptID` names the child prompt admitted for the started or joined generation; closing the generation cancels it if unread. */
  readonly start: (recovery: Recovery, promptID?: SessionMessage.ID) => Effect.Effect<Job.Info>
  /** Cancels the admitted prompts a closed generation never read and appends what was not delivered to its outcome. */
  readonly settle: <T extends Outcome>(info: T) => Effect.Effect<T>
  background: (recovery: Recovery) => Effect.Effect<void>
  notify: (recovery: Recovery, startedAt: number) => Effect.Effect<void>
  current: (childSessionID: Session.ID) => Effect.Effect<Job.Info | undefined>
  readonly join: (
    recovery: Recovery,
    promptID: SessionMessage.ID,
    publish: Effect.Effect<void, unknown>,
  ) => Effect.Effect<boolean, unknown>
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
  const instances = yield* Instance.Service
  const store = yield* SessionStore.Service
  const { db } = yield* Database.Service
  const bus = yield* Bus.Service
  const scope = yield* Scope.Scope
  // Jobs and their completion observers outlive the plugin that launched them.
  // Fork with the global context too, rather than retaining the caller's location.
  const context = yield* Effect.context<never>()
  // Child prompts admitted for a running generation, by generation. Closing the generation cancels the unread ones.
  const admitted = new Map<string, Admitted>()
  // Generations whose prompts are closed, with the note on what was left undelivered, until their observer is done.
  const closing = new Map<string, Deferred.Deferred<string | undefined>>()
  // Native generations that already have an observer in this process, whether they started here or joined a job resumed at restart.
  const watched = new Set<string>()
  // One observer per job generation, including continuations of the same child.
  const notifications = new Set<string>()
  const ending = new Set<string>()
  const revisions = new Map<string, number>()
  const noticeWhileHeld = Effect.fnUntraced(function* (held: {
    readonly child: Session.Info
    readonly parentID: Session.ID
    readonly assistantID: SessionMessage.ID
    readonly since: number
    readonly started: Deferred.Deferred<void>
  }) {
    const ownRunning = jobs.backgroundJobs.pipe(
      Effect.map((items) =>
        items.filter(
          (item) =>
            item.sessionID === held.child.id &&
            item.status === "running" &&
            (item.kind === "shell" || item.kind === "codemode"),
        ),
      ),
    )
    const running = yield* ownRunning
    if (running.length === 0) return
    const experimental = yield* Config.Service.use((config) => config.entries()).pipe(
      instances.provide(held.child),
      Effect.map((entries) => Config.latest(entries, "experimental")),
    )
    const reminder = experimental?.subagent_job_reminder_minutes ?? 7
    const leadNote = experimental?.subagent_job_lead_note_minutes ?? 20
    if (reminder === 0 && leadNote === 0) return

    const send = Effect.fnUntraced(function* (kind: "reminder" | "lead-note", minutes: number) {
      if (minutes === 0) return
      const now = yield* Clock.currentTimeMillis
      yield* Effect.sleep(Duration.millis(Math.max(0, held.since + minutes * 60_000 - now)))
      const current = yield* ownRunning
      if (current.length === 0 || (yield* execution.isActive(held.child.id))) return
      const elapsed = yield* Clock.currentTimeMillis
      const description = kind === "reminder" ? "Background job reminder" : "Subagent still waiting on jobs"
      const text =
        kind === "reminder"
          ? [
              "Your background jobs are still running:",
              ...current.map(
                (job) =>
                  `- ${job.id} (${job.kind}, ${Math.floor(Math.max(0, elapsed - job.time.started) / 1_000)}s): ${JSON.stringify(job.title ?? job.kind)}`,
              ),
              "Check whether each job is still making progress. Stop any hung job. If the jobs are legitimately busy, end your turn and let them continue.",
            ].join("\n")
          : `Subagent ${held.child.id} is still waiting on jobs ${current.map((job) => job.id).join(", ")} after ${Math.floor((elapsed - held.since) / 60_000)} minutes.`
      // Stable per assistant turn: recovering the same idle boundary cannot admit either notice again.
      yield* sessions.synthetic({
        id: SessionMessage.ID.make(`msg_subagent_job_${kind}_${held.assistantID}`),
        sessionID: kind === "reminder" ? held.child.id : held.parentID,
        description,
        text,
        metadata: { notice: `subagent-job-${kind}`, childID: held.child.id, jobIDs: current.map((job) => job.id) },
        ...(kind === "lead-note" ? { delivery: "queue", resume: false } : {}),
      })
    })
    yield* Effect.raceAllFirst([
      Deferred.await(held.started),
      Effect.forEach(running, (job) => jobs.wait({ id: job.id }), { concurrency: "unbounded", discard: true }),
      Effect.all([send("reminder", reminder), send("lead-note", leadNote)], { concurrency: 2, discard: true }),
    ])
  })
  const restorePrompts = Effect.fnUntraced(function* (
    recovery: Pick<Recovery, "pluginID" | "generation" | "parentSessionID" | "childSessionID">,
  ) {
    if (recovery.pluginID === undefined || recovery.generation === undefined || closing.has(recovery.generation)) return
    const pending = yield* SessionInbox.list(db, recovery.childSessionID)
    for (const item of pending) {
      if (item.type !== "user") continue
      const binding = SubagentSteerBinding.decode(item.payload.metadata?.opencodeSubagentSteer)
      if (
        Option.isNone(binding) ||
        binding.value.pluginID !== recovery.pluginID ||
        binding.value.parentSessionID !== recovery.parentSessionID ||
        binding.value.generation !== recovery.generation ||
        item.id !== SubagentSteerBinding.promptID(binding.value)
      )
        continue
      const owner = yield* admissions.get(recovery.pluginID, binding.value.admissionID)
      if (
        owner?.childSessionID !== recovery.childSessionID ||
        owner.generation !== recovery.generation ||
        owner.parentSessionID !== recovery.parentSessionID
      )
        continue
      const entry = admitted.get(recovery.generation)
      if (entry) entry.ids.add(item.id)
      else admitted.set(recovery.generation, { sessionID: recovery.childSessionID, ids: new Set([item.id]) })
    }
  })
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

  const unread = (entry: Admitted) =>
    sessions.inbox(entry.sessionID).pipe(
      Effect.catchTag("Session.NotFoundError", () => Effect.succeed([])),
      Effect.map((items) => items.flatMap((item) => (item.type === "user" && entry.ids.has(item.id) ? [item] : []))),
    )

  // Cancels the entry's unread prompts and words what was left undelivered.
  const cancelUnread = (entry: Admitted): Effect.Effect<string | undefined> =>
    unread(entry).pipe(
      Effect.flatMap((items) =>
        Effect.forEach(items, (item) =>
          sessions.cancelInbox({ sessionID: entry.sessionID, inboxID: item.id }).pipe(
            Effect.as([{ id: item.id, text: item.payload.text }]),
            // The child consumed it meanwhile, or the session is gone: nothing is left to cancel.
            Effect.catchTag(["Session.InboxConflictError", "Session.NotFoundError"], () => Effect.succeed([])),
          ),
        ),
      ),
      Effect.map((cancelled) => {
        const prompts = cancelled.flat()
        return prompts.length === 0 ? undefined : SubagentCompletion.undelivered(prompts)
      }),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) =>
          Effect.logError("Failed to cancel unread subagent prompts", { sessionID: entry.sessionID, cause }).pipe(
            Effect.as(undefined),
          ),
      ),
    )

  // The first caller closes a generation's admitted prompts and shares its note with later callers. The claim is
  // taken before the cancel runs, so an interrupted caller must not abandon it: the cancel runs to completion.
  const close = (generation: string): Effect.Effect<string | undefined> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const closed = closing.get(generation)
        if (closed !== undefined) return restore(Deferred.await(closed))
        const entry = admitted.get(generation)
        if (entry === undefined) return Effect.succeed(undefined)
        admitted.delete(generation)
        const done = Deferred.makeUnsafe<string | undefined>()
        closing.set(generation, done)
        // Whatever the cancel's exit, the waiters get an answer: an interrupt cause never reaches them.
        return cancelUnread(entry).pipe(
          Effect.onExit((exit) => Deferred.succeed(done, Exit.isSuccess(exit) ? exit.value : undefined)),
        )
      }),
    )

  // Registers a prompt for its generation. A generation that closed without the admissions lock (a cancel) never saw
  // it, so the prompt is cancelled and reported at once, the way the generation's observer would have.
  const register = Effect.fnUntraced(function* (recovery: Recovery, info: Job.Info, promptID: SessionMessage.ID) {
    const entry = admitted.get(info.generation)
    if (entry === undefined)
      admitted.set(info.generation, { sessionID: recovery.childSessionID, ids: new Set([promptID]) })
    else entry.ids.add(promptID)
    const live = yield* jobs.get(recovery.childSessionID)
    if (!closing.has(info.generation) && live?.generation === info.generation && live.status === "running") return
    const registered = admitted.get(info.generation)
    registered?.ids.delete(promptID)
    if (registered?.ids.size === 0) admitted.delete(info.generation)
    const note = yield* cancelUnread({ sessionID: recovery.childSessionID, ids: new Set([promptID]) })
    if (note === undefined) return
    const status = live?.generation === info.generation && live.status !== "running" ? live.status : "cancelled"
    // The start that registered this prompt must not fail over its report: a parent deleted meanwhile has nobody to tell.
    yield* SubagentCompletion.deliver(sessions, jobs, { status, output: note, error: note, recovery }).pipe(
      Effect.ignoreCause({ log: "Error", message: "Failed to report an unread subagent prompt" }),
    )
  })

  const settle = <T extends Outcome>(info: T): Effect.Effect<T> =>
    info.status === "running"
      ? Effect.succeed(info)
      : Effect.gen(function* () {
          const owners = yield* admissions.list()
          yield* Effect.forEach(
            owners.filter((owner) => owner.generation === info.generation),
            restorePrompts,
            { discard: true },
          )
          const note = yield* close(info.generation)
          return note === undefined ? info : annotate(info, note)
        })

  // A native generation reports its outcome from the child's settlement, so the undelivered prompts follow as their own report.
  const reportUndelivered = Effect.fnUntraced(function* (recovery: Recovery, info: Job.Info) {
    const note = yield* close(info.generation)
    closing.delete(info.generation)
    if (note !== undefined)
      yield* SubagentCompletion.deliver(sessions, jobs, { status: info.status, output: note, error: note, recovery })
  })

  const notify = Effect.fn("SubagentJob.notify")(function* (recovery: Recovery, startedAt: number) {
    const key = `${recovery.childSessionID}:${recovery.generation ?? startedAt}`
    if (notifications.has(key)) return
    notifications.add(key)
    yield* Effect.gen(function* () {
      const waited = (yield* jobs.wait({ id: recovery.childSessionID, generation: recovery.generation })).info
      const info = waited && (yield* settle(waited))
      if (info) {
        ending.delete(info.generation)
        // The owning plugin's cancel marks its admissions before it stops the job. That caller already has the
        // outcome, so it is recorded on the Job and admission without a parent completion wake.
        let ownerCancelled = false
        if (recovery.pluginID !== undefined)
          yield* admissions.serialized(
            Effect.gen(function* () {
              const entries = yield* admissions.list(recovery.pluginID)
              for (const entry of entries) {
                if (entry.childSessionID !== recovery.childSessionID || entry.generation !== info.generation) continue
                if (entry.ownerCancelled === true && info.status === "cancelled") ownerCancelled = true
                yield* admissions.put({ ...entry, status: info.status, output: info.output, error: info.error })
              }
            }),
          )
        const member = info.notificationID
          ? yield* jobs.completionMember(recovery.parentSessionID, recovery.childSessionID, info.notificationID)
          : undefined
        if (!ownerCancelled || member) {
          const outstanding =
            member && info.status === "completed"
              ? yield* SessionBackground.outstanding(jobs, store, recovery.childSessionID, yield* execution.active)
              : []
          const result = {
            ...info,
            recovery: member ? { ...recovery, completionMember: member, outstanding } : recovery,
          }
          if (member && info.notificationID) yield* jobs.updateCompletionSnapshot(info.notificationID, result.recovery)
          yield* SubagentCompletion.deliver(sessions, jobs, result)
        }
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          notifications.delete(key)
          if (recovery.generation !== undefined) closing.delete(recovery.generation)
        }),
      ),
      // The global context drops the caller's span annotations; delivery is the parent session's work.
      Effect.annotateSpans("session.id", recovery.parentSessionID),
      Effect.forkIn(scope, { startImmediately: true }),
      Effect.setContext(context),
    )
  })

  const startGeneration = Effect.fn(function* (recovery: Recovery, promptID?: SessionMessage.ID) {
    yield* restorePrompts(recovery)
    const active = yield* current(recovery.childSessionID)
    if (active !== undefined) revisions.set(active.generation, (revisions.get(active.generation) ?? 0) + 1)
    return yield* jobs
      .start({
        id: recovery.childSessionID,
        type: "subagent",
        title: recovery.description,
        metadata: {},
        recovery,
        background: recovery.pluginID === undefined,
        generation: recovery.generation,
        notificationID:
          recovery.generation === undefined ? undefined : SessionMessage.ID.make(`msg_subagent_${recovery.generation}`),
        durable: recovery.pluginID !== undefined,
        accept:
          recovery.pluginID === undefined
            ? undefined
            : (info) =>
                bus
                  .publish(
                    SessionEvent.ChildAccepted,
                    {
                      sessionID: recovery.parentSessionID,
                      childSessionID: recovery.childSessionID,
                      generation: info.generation,
                    },
                    { id: Event.ID.make(`evt_subagent_accepted_${info.generation}`) },
                  )
                  .pipe(Effect.asVoid),
        run: Effect.gen(function* () {
          const startedSeq =
            (yield* execution.periodStartSeq(recovery.childSessionID)) ??
            (yield* Bus.latestSequence(db, recovery.childSessionID))
          const info = yield* jobs.get(recovery.childSessionID)
          const generation = info?.generation ?? recovery.generation
          const revision = generation === undefined ? 0 : (revisions.get(generation) ?? 0)
          const abandoned = yield* execution.recovery(recovery.childSessionID, generation).pipe(Effect.result)
          if (recovery.pluginID !== undefined && abandoned._tag === "Failure")
            return yield* Effect.fail(abandoned.failure)
          const resumed =
            abandoned._tag === "Failure"
              ? Exit.fail(abandoned.failure)
              : yield* sessions.resume(recovery.childSessionID).pipe(Effect.exit)
          let recovered = abandoned._tag === "Success" && abandoned.success === "committed"
          // Prompts already woken once for a finished run: a second unread outcome is final, not another wake.
          const rewoken = new Set<SessionMessage.ID>()
          while (true) {
            const started = yield* Deferred.make<void>()
            const unsubscribe = yield* bus.listen((event) =>
              event.type === SessionEvent.Execution.Started.type &&
              event.durable?.aggregateID === recovery.childSessionID
                ? Deferred.succeed(started, undefined).pipe(Effect.asVoid)
                : Effect.void,
            )
            const result = yield* Effect.gen(function* () {
              yield* sessions.wait(recovery.childSessionID)
              const since = yield* Clock.currentTimeMillis
              const recoveryResult = yield* execution.recovery(recovery.childSessionID, generation).pipe(Effect.result)
              recovered = (recoveryResult._tag === "Success" && recoveryResult.success === "committed") || recovered
              const result = yield* admissions.serialized(
                Effect.gen(function* () {
                  if (yield* execution.isActive(recovery.childSessionID)) return undefined
                  yield* restorePrompts(recovery)
                  const messages = yield* sessions.messages({
                    sessionID: recovery.childSessionID,
                    order: "desc",
                    limit: 20,
                  })
                  const assistant = messages.find((message) => message.type === "assistant")
                  if (recovery.pluginID !== undefined && recoveryResult._tag === "Failure")
                    return Exit.fail(recoveryResult.failure)
                  if (recoveryResult._tag === "Failure") {
                    const child = yield* sessions.get(recovery.childSessionID)
                    if (child.outcome === "failed") return Exit.fail(assistant?.error ?? recoveryResult.failure)
                    if (child.outcome !== "succeeded") return "await-start" as const
                    recovered = true
                  }
                  const info = yield* jobs.get(recovery.childSessionID)
                  const child = yield* sessions.get(recovery.childSessionID)
                  const resumeFailed =
                    !recovered &&
                    Exit.isFailure(resumed) &&
                    (generation === undefined || (revisions.get(generation) ?? 0) === revision)
                  // A plugin generation is still open, so a prompt admitted for it that the finished run left unread had
                  // its wake lost: start the next run for it. A native generation already reported at the child's
                  // settlement, so a later run's answer would reach nobody; its unread prompts are cancelled when it closes.
                  const entry =
                    recovery.pluginID === undefined || info === undefined ? undefined : admitted.get(info.generation)
                  if (
                    entry !== undefined &&
                    info !== undefined &&
                    !resumeFailed &&
                    child.outcome !== "failed" &&
                    child.outcome !== "interrupted"
                  ) {
                    const stranded = (yield* unread(entry)).filter((item) => !rewoken.has(item.id))
                    if (stranded.length > 0) {
                      stranded.forEach((item) => {
                        rewoken.add(item.id)
                      })
                      // Every execution publishes Started before its first drain, so this resolves even if the row is cancelled meanwhile.
                      yield* execution.wake(recovery.childSessionID)
                      return "await-start" as const
                    }
                  }
                  if (recovery.pluginID !== undefined && !resumeFailed && child.outcome === "succeeded") {
                    const outstanding = (yield* jobs.pendingBackground).some(
                      ({ recovery: work }) =>
                        (work.kind === "shell" || work.kind === "codemode") && work.sessionID === child.id,
                    )
                    // Keep the generation open until the job notifier wakes the child. Include finished jobs
                    // whose notice is not yet admitted; the notifier consumes the row only after waking.
                    if (outstanding) return { held: child, assistantID: assistant?.id }
                    if ((yield* execution.isActive(child.id)) || (yield* Deferred.isDone(started))) return undefined
                  }
                  if (info !== undefined) ending.add(info.generation)
                  if (resumeFailed) return Exit.failCause(resumed.cause)
                  if (child.outcome === "failed" || child.outcome === "interrupted")
                    return Exit.fail(assistant?.error ?? new Error(`Subagent execution ${child.outcome}`))
                  if (recovery.pluginID !== undefined) {
                    const observed = yield* store
                      .lastAssistantAfter({ sessionID: recovery.childSessionID, afterSeq: startedSeq })
                      .pipe(
                        Effect.catchCauseIf(
                          (cause) => !Cause.hasInterrupts(cause),
                          (cause) =>
                            Effect.logWarning("subagent output model observation failed", {
                              sessionID: recovery.childSessionID,
                              cause,
                            }).pipe(Effect.as(undefined)),
                        ),
                      )
                    if (
                      observed !== undefined &&
                      observed.id === assistant?.id &&
                      generation !== undefined &&
                      assistant.content.some((part) => part.type === "text" && part.text.length > 0)
                    ) {
                      const entries = yield* admissions.list(recovery.pluginID)
                      for (const entry of entries) {
                        if (entry.childSessionID === recovery.childSessionID && entry.generation === generation)
                          yield* admissions.put({ ...entry, outputModel: observed.model })
                      }
                    }
                    return Exit.succeed(SubagentCompletion.text(assistant))
                  }
                  return Exit.succeed("")
                }),
              )
              if (result === "await-start" || (result && "held" in result)) {
                if (result !== "await-start" && result.assistantID)
                  yield* noticeWhileHeld({
                    child: result.held,
                    parentID: recovery.parentSessionID,
                    assistantID: result.assistantID,
                    since,
                    started,
                  }).pipe(Effect.ignoreCause({ log: "Warn", message: "Failed to send held subagent job notices" }))
                yield* Deferred.await(started)
                return undefined
              }
              return result
            }).pipe(Effect.ensuring(unsubscribe))
            if (result === undefined) continue
            if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause)
            return result.value
          }
        }).pipe(
          Effect.onInterrupt(() =>
            jobs
              .isCancelled(recovery.childSessionID)
              .pipe(
                Effect.flatMap((cancelled) => (cancelled ? execution.interrupt(recovery.childSessionID) : Effect.void)),
              ),
          ),
          Effect.onExit(() =>
            Effect.gen(function* () {
              const info = yield* jobs.get(recovery.childSessionID)
              if (info !== undefined) ending.add(info.generation)
            }),
          ),
        ),
      })
      .pipe(
        Effect.tap((info) => (promptID === undefined ? Effect.void : register(recovery, info, promptID))),
        Effect.tap((info) =>
          recovery.pluginID === undefined ? Effect.void : execution.bindJob(recovery.childSessionID, info.generation),
        ),
        Effect.tap(() => (recovery.pluginID === undefined ? Effect.void : execution.wake(recovery.childSessionID))),
        Effect.tap((info) => {
          // A plugin generation reports through notify. A native one reports at the child's settlement, so its
          // first start in this process also forks the observer that closes it. A plugin start claims its generation
          // too, so a native follow-up that joins it leaves the closing to notify.
          const closes = recovery.pluginID === undefined && !watched.has(info.generation)
          watched.add(info.generation)
          return jobs.wait({ id: info.id, generation: info.generation }).pipe(
            Effect.tap((waited) =>
              closes && waited.info !== undefined ? reportUndelivered(recovery, waited.info) : Effect.void,
            ),
            Effect.tap(() =>
              Effect.sync(() => {
                ending.delete(info.generation)
                revisions.delete(info.generation)
                watched.delete(info.generation)
              }),
            ),
            Effect.forkIn(scope, { startImmediately: true }),
          )
        }),
      )
  })
  return Service.of({
    start: (recovery, promptID) =>
      (recovery.pluginID === undefined
        ? admissions.serialized(startGeneration(recovery, promptID))
        : startGeneration(recovery, promptID)
      ).pipe(Effect.setContext(context)),
    settle,
    current,
    join: Effect.fn("SubagentJob.join")(function* (recovery, promptID, publish) {
      const info = yield* jobs.get(recovery.childSessionID)
      if (
        info?.status !== "running" ||
        info.generation !== recovery.generation ||
        ending.has(info.generation) ||
        closing.has(info.generation)
      )
        return false
      yield* publish
      if (admitted.get(info.generation)?.ids.has(promptID)) return true
      revisions.set(info.generation, (revisions.get(info.generation) ?? 0) + 1)
      yield* register(recovery, info, promptID)
      yield* execution.wake(recovery.childSessionID)
      return true
    }),
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
  deps: [
    Session.node,
    Job.node,
    SubagentAdmissionStore.node,
    SessionExecution.node,
    Instance.node,
    SessionStore.node,
    Database.node,
    Bus.node,
  ],
})
