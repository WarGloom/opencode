export * as SubagentAdmissionRun from "./subagent-admission-run.js"

import type { AcceptSkillsInput, Receipt, RunRef, StartInput, Target, WaitInput, WaitResult } from "@opencode/plugin/subagent"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Node } from "@opencode/util/effect/app-node"
import { Job } from "../job.js"
import { Session } from "../session.js"
import { SessionInbox } from "./inbox.js"
import { SubagentAdmission } from "./subagent-admission.js"
import { SubagentAdmissionSkills } from "./subagent-admission-skills.js"
import { SubagentAdmissionStore } from "./subagent-admission-store.js"
import { SubagentJob } from "./subagent-job.js"
import { SubagentCompletion } from "./subagent-completion.js"

export interface Interface {
  readonly acceptSkills: (pluginID: string, input: AcceptSkillsInput) => Effect.Effect<readonly SessionMessage.SkillActivation[], unknown>
  readonly start: (pluginID: string, input: StartInput) => Effect.Effect<Receipt, unknown>
  readonly ready: (pluginID: string, input: { readonly run: RunRef }) => Effect.Effect<Receipt, unknown>
  readonly get: (pluginID: string, input: Target) => Effect.Effect<Receipt | undefined, unknown>
  readonly wait: (pluginID: string, input: WaitInput) => Effect.Effect<WaitResult, unknown>
  readonly cancel: (pluginID: string, input: Target) => Effect.Effect<Receipt, unknown>
  readonly reconcile: (pluginID: string, input?: { readonly parentSessionID?: Session.ID }) => Effect.Effect<readonly Receipt[], unknown>
}

const terminal = (status: SubagentAdmissionStore.Entry["status"]) => status === "completed" || status === "error" || status === "cancelled"
const anchors = (entry: SubagentAdmissionStore.Entry) => entry.invocation.kind === "tool" && entry.invocation.team !== undefined

export const make: Effect.Effect<Interface, never, SubagentAdmissionStore.Service | SubagentAdmission.Service | Session.Service | SessionInbox.Service | Job.Service | SubagentJob.Service> = Effect.gen(function* () {
  const admissions = yield* SubagentAdmissionStore.Service
  const authorization = yield* SubagentAdmission.Service
  const sessions = yield* Session.Service
  const inbox = yield* SessionInbox.Service
  const jobs = yield* Job.Service
  const subagents = yield* SubagentJob.Service
  const acceptSkills = yield* SubagentAdmissionSkills.make
  const resolve = (entry: SubagentAdmissionStore.Entry, outcome: "started" | "cancelled") =>
    inbox.resolveChild({ sessionID: entry.parentSessionID, admissionID: SubagentAdmissionStore.key(entry.pluginID, entry.admissionID), outcome })
  const refresh = Effect.fn(function* (entry: SubagentAdmissionStore.Entry) {
    if (entry.generation === undefined || entry.status === "prepared" || entry.status === "cancelled") return entry
    const pending = yield* jobs.pendingBackground
    const background = pending.find((item) => item.recovery.kind === "subagent" &&
      item.recovery.pluginID === entry.pluginID && item.recovery.generation === entry.generation)
    if (background === undefined || background.status === "running") return entry
    const updated = { ...entry, status: background.status, output: background.output, error: background.error }
    yield* admissions.put(updated)
    return updated
  })

  const find = Effect.fn(function* (pluginID: string, target: Target) {
    if ("admissionID" in target) return yield* admissions.get(pluginID, target.admissionID)
    const entries = yield* admissions.list(pluginID)
    return entries.find((entry) => entry.childSessionID === target.run.childSessionID && entry.generation === target.run.generation)
  })
  const requireEntry = Effect.fn(function* (pluginID: string, target: Target) {
    const recorded = yield* find(pluginID, target)
    const entry = recorded === undefined ? undefined : yield* refresh(recorded)
    if (entry === undefined)
      return yield* new SubagentAdmissionStore.Conflict({ admissionID: "admissionID" in target ? target.admissionID : target.run.generation, reason: "Unknown admission or generation" })
    return entry
  })
  const activate = Effect.fn(function* (entry: SubagentAdmissionStore.Entry, phase: "start" | "resume" = "start") {
    if (entry.start === undefined || entry.generation === undefined) return SubagentAdmission.receipt(entry)
    yield* authorization.check(entry, phase)
    const start = entry.start
    yield* sessions.prompt({
      sessionID: entry.childSessionID,
      id: start.promptID,
      ...start.prompt,
      metadata: start.metadata,
      delivery: start.delivery,
      resume: false,
      ...(entry.skills === undefined ? {} : { acceptedSkillActivations: entry.skills.selections.map((selection) => selection.activationID) }),
    })
    const recovery = {
      kind: "subagent" as const,
      parentSessionID: entry.parentSessionID,
      childSessionID: entry.childSessionID,
      agent: entry.agent,
      description: entry.description,
      pluginID: entry.pluginID,
      admissionID: entry.admissionID,
      generation: entry.generation,
      completion: start.completion,
    }
    const info = yield* subagents.start(recovery)
    if (info.generation !== entry.generation)
      return yield* new SubagentAdmissionStore.Conflict({ admissionID: entry.admissionID, reason: "Child generation changed" })
    const running = { ...entry, status: "running" as const }
    yield* admissions.put(running)
    // Resolved explicitly: a steering follow-up joining an active generation starts no new Job.
    yield* resolve(running, "started")
    yield* subagents.background(recovery)
    return SubagentAdmission.receipt(running)
  })
  const wait = Effect.fn(function* (pluginID: string, input: { readonly run: RunRef; readonly timeout?: number }) {
    const entry = yield* requireEntry(pluginID, { run: input.run })
    if (entry.status !== "running") return { receipt: SubagentAdmission.receipt(entry), timedOut: entry.status === "accepted" }
    const result = yield* jobs.wait({ id: input.run.childSessionID, generation: input.run.generation, timeout: input.timeout })
    return yield* admissions.serialized(Effect.gen(function* () {
      // An owner cancellation stamps the durable entry and consumes the Job, so the stored terminal entry wins
      // over whatever the Job wait saw, and is never overwritten with a pre-cancel copy.
      const current = (yield* find(pluginID, { run: input.run })) ?? entry
      if (terminal(current.status)) return { receipt: SubagentAdmission.receipt(current), timedOut: false }
      if (result.info === undefined) return { receipt: SubagentAdmission.receipt(current), timedOut: true }
      const updated = { ...current, status: result.info.status, output: result.info.output, error: result.info.error }
      if (!result.timedOut) yield* admissions.put(updated)
      return { receipt: SubagentAdmission.receipt(updated), timedOut: result.timedOut }
    }))
  })
  const start = Effect.fn(function* (pluginID: string, input: StartInput) {
    const receipt = yield* admissions.serialized(Effect.gen(function* () {
      const entry = yield* requireEntry(pluginID, { admissionID: input.admissionID })
      if (entry.status !== "prepared") return SubagentAdmission.receipt(entry)
      if ((entry.invocation.kind === "team" || anchors(entry)) && input.completion !== "none")
        return yield* new SubagentAdmissionStore.Conflict({ admissionID: input.admissionID, reason: "Team generation requires completion none" })
      const promptID = input.promptID ?? entry.skills?.promptID ?? SubagentAdmission.promptID(pluginID, input.admissionID)
      const skills = entry.skills
      const requested = input.prompt.skills ?? []
      if (skills !== undefined && (promptID !== skills.promptID || requested.length !== skills.selections.length ||
        requested.some((selection, index) => selection.id !== skills.selections[index]?.skill || selection.arguments !== skills.selections[index]?.arguments)))
        return yield* new SubagentAdmissionStore.Conflict({ admissionID: input.admissionID, reason: "Start does not match accepted skills" })
      const active = yield* subagents.current(entry.childSessionID)
      const peers = yield* admissions.list()
      const owner = peers.find((peer) => peer.childSessionID === entry.childSessionID && peer.generation === active?.generation)
      if (active?.status === "running" && (owner?.pluginID !== pluginID || owner.start?.completion !== input.completion))
        return yield* new SubagentAdmissionStore.Conflict({ admissionID: input.admissionID, reason: "Active generation owner or completion differs" })
      const accepted = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SubagentAdmissionStore.Entry))(JSON.stringify({
        ...entry,
        status: "accepted",
        generation: active?.status === "running" ? active.generation : crypto.randomUUID(),
        start: { ...input, promptID },
      }))
      yield* authorization.check(accepted)
      yield* admissions.put(accepted)
      return yield* activate(accepted)
    }))
    if (input.mode === "foreground" && receipt.run !== undefined && receipt.status === "running")
      return (yield* wait(pluginID, { run: receipt.run }).pipe(
        Effect.onInterrupt(() => cancel(pluginID, { admissionID: receipt.admissionID }).pipe(Effect.orDie)),
      )).receipt
    return receipt
  })
  const ready = Effect.fn(function* (pluginID: string, input: { readonly run: RunRef }) {
    return yield* admissions.serialized(Effect.gen(function* () {
      const entry = yield* requireEntry(pluginID, { run: input.run })
      const pending = yield* jobs.pendingBackground
      const background = pending.find((item) => item.recovery.kind === "subagent" &&
        item.recovery.pluginID === pluginID && item.recovery.generation === input.run.generation)
      if (background !== undefined && background.status !== "running" && background.recovery.kind === "subagent") {
        yield* SubagentCompletion.deliver(sessions, jobs, { ...background, recovery: background.recovery })
        return SubagentAdmission.receipt(entry)
      }
      if (entry.status !== "accepted" && entry.status !== "running")
        return SubagentAdmission.receipt(entry)
      const active = yield* subagents.current(entry.childSessionID)
      if (active?.generation === input.run.generation) return SubagentAdmission.receipt(entry)
      if (active !== undefined)
        return yield* new SubagentAdmissionStore.Conflict({ admissionID: entry.admissionID, reason: "Recovered generation was superseded" })
      const resumed = entry.status === "running" && background?.recovery.kind === "subagent" &&
        background.recovery.childSessionID === entry.childSessionID &&
        background.recovery.parentSessionID === entry.parentSessionID && background.recovery.agent === entry.agent
      return yield* activate(entry, resumed ? "resume" : "start")
    }))
  })
  // Runs under the store lock. Revoking an anchor keeps its historical outcome and ends every later team generation it authorized.
  // Runs under the store lock: ends one non-terminal generation and interrupts any pending authorization.
  const stop = Effect.fn(function* (pluginID: string, entry: SubagentAdmissionStore.Entry) {
    const peers = entry.generation === undefined ? [entry] : (yield* admissions.list(pluginID))
      .filter((peer) => peer.childSessionID === entry.childSessionID && peer.generation === entry.generation)
    const pending = entry.status === "authorizing" ? [] : yield* sessions.inbox(entry.childSessionID)
    for (const peer of peers) {
      if (peer.start !== undefined && pending.some((item) => item.id === peer.start?.promptID))
        yield* sessions.cancelInbox({ sessionID: peer.childSessionID, inboxID: peer.start.promptID }).pipe(
          Effect.catchTag("Session.InboxConflictError", () => Effect.void),
        )
      yield* admissions.put({ ...peer, status: "cancelled", ownerCancelled: true })
      yield* resolve(peer, "cancelled")
    }
    if (entry.generation !== undefined) {
      const info = yield* jobs.get(entry.childSessionID)
      if (info?.generation === entry.generation && info.status === "running") {
        yield* sessions.interrupt(entry.childSessionID)
        const cancelled = yield* jobs.cancel(entry.childSessionID, entry.generation)
        // The caller already has the outcome; consume the durable notification so restart does not wake the parent.
        if (cancelled?.notificationID !== undefined) yield* jobs.completeBackground(cancelled.notificationID)
      }
    }
    yield* admissions.cancelAuthorization(pluginID, entry.admissionID, SubagentAdmission.receipt({ ...entry, status: "cancelled" }))
  })
  // Revoking an anchor keeps its historical outcome and ends every later team generation it authorized.
  const cancelEntry = Effect.fn(function* (pluginID: string, entry: SubagentAdmissionStore.Entry) {
    const revoke = anchors(entry) && entry.revoked !== true
    if (terminal(entry.status) && !revoke) return SubagentAdmission.receipt(entry)
    if (!terminal(entry.status)) yield* stop(pluginID, entry)
    const cancelled = terminal(entry.status)
      ? { ...entry, revoked: true as const }
      : { ...entry, status: "cancelled" as const, ownerCancelled: true as const, ...(revoke ? { revoked: true as const } : {}) }
    yield* admissions.put(cancelled)
    if (revoke) {
      const bound = (yield* admissions.list(pluginID)).filter((peer) => !terminal(peer.status) &&
        peer.invocation.kind === "team" && peer.invocation.provisioningAdmissionID === entry.admissionID)
      yield* Effect.forEach(bound, (peer) => stop(pluginID, peer), { discard: true })
    }
    return SubagentAdmission.receipt(cancelled)
  })
  const cancel = Effect.fn(function* (pluginID: string, target: Target) {
    return yield* admissions.serialized(requireEntry(pluginID, target).pipe(Effect.flatMap((entry) => cancelEntry(pluginID, entry))))
  })
  return {
    acceptSkills,
    start,
    ready,
    wait,
    cancel,
    get: (pluginID: string, target: Target) => admissions.serialized(Effect.gen(function* () {
      const entry = yield* find(pluginID, target)
      return entry === undefined ? undefined : SubagentAdmission.receipt(yield* refresh(entry))
    })),
    // Reconciliation also resolves preparation markers left by a crash after start or cancellation.
    reconcile: (pluginID: string, input?: { readonly parentSessionID?: Receipt["parentSessionID"] }) =>
      admissions.serialized(admissions.list(pluginID).pipe(
        Effect.flatMap((entries) => Effect.forEach(entries.filter((entry) => input?.parentSessionID === undefined || entry.parentSessionID === input.parentSessionID), refresh)),
        Effect.tap((entries) => Effect.forEach(entries, (entry) =>
          entry.status === "cancelled" ? resolve(entry, "cancelled")
            : entry.status === "running" || entry.status === "completed" || entry.status === "error" ? resolve(entry, "started")
            : Effect.void, { discard: true })),
        Effect.map((entries) => entries.map(SubagentAdmission.receipt)),
      )),
  }
})

export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentAdmissionRun") {}
export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.location> = Node.makeLocationNode({
  service: Service,
  layer: Layer.effect(Service, make),
  deps: [SubagentAdmissionStore.node, SubagentAdmission.node, Session.node, SessionInbox.node, Job.node, SubagentJob.node],
})
