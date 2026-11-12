export * as SubagentAdmission from "./subagent-admission.js"

import type { PrepareInput, Receipt } from "@opencode/plugin/subagent"
import { Context, Effect, Exit, Layer, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { Node } from "@opencode/util/effect/app-node"
import { Hash } from "@opencode/util/hash"
import { Agent } from "../agent.js"
import { Config } from "../config.js"
import { Command } from "../command.js"
import { Model } from "../model.js"
import { Permission } from "../permission.js"
import { Session } from "../session.js"
import { SessionInbox } from "./inbox.js"
import { SubagentAdmissionStore } from "./subagent-admission-store.js"
import { SessionMessage } from "./message.js"
import type { LayerNode } from "@opencode/util/effect/layer-node"

export interface Interface {
  readonly prepare: (pluginID: string, input: PrepareInput) => Effect.Effect<Receipt, unknown>
  readonly check: (entry: SubagentAdmissionStore.Entry, phase?: "start" | "resume") => Effect.Effect<void, Permission.BlockedError | Session.NotFoundError | SubagentAdmissionStore.Conflict>
}

export function receipt(entry: SubagentAdmissionStore.Entry): Receipt {
  return {
    admissionID: entry.admissionID,
    parentSessionID: entry.parentSessionID,
    childSessionID: entry.childSessionID,
    status: entry.status,
    ...(entry.generation === undefined ? {} : { run: { childSessionID: entry.childSessionID, generation: entry.generation } }),
    promptID: entry.start?.promptID ?? promptID(entry.pluginID, entry.admissionID),
    ...(entry.start === undefined ? {} : { completion: entry.start.completion }),
    ...(entry.output === undefined ? {} : { output: entry.output }),
    ...(entry.outputModel === undefined ? {} : { outputModel: entry.outputModel }),
    ...(entry.error === undefined ? {} : { error: entry.error }),
    ...(entry.revoked === undefined ? {} : { revoked: entry.revoked }),
  }
}

export const promptID = (pluginID: string, admissionID: string) => SessionMessage.ID.make(`msg_${Hash.sha256(JSON.stringify([pluginID, admissionID]))}`)

// Only these OMO tools provision a long-lived team member that may run a primary-mode agent.
const teamTools = new Set(["team_create", "team_add_member"])

type Binding = Pick<SubagentAdmissionStore.Entry, "pluginID" | "admissionID" | "parentSessionID" | "childSessionID" | "agent" | "invocation">

export const make: Effect.Effect<Interface, never, Session.Service | SessionInbox.Service | Agent.Service | Model.Service | Permission.Service | Config.Service | Command.Service | SubagentAdmissionStore.Service> = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const inbox = yield* SessionInbox.Service
  const agents = yield* Agent.Service
  const models = yield* Model.Service
  const permission = yield* Permission.Service
  const config = yield* Config.Service
  const commands = yield* Command.Service
  const admissions = yield* SubagentAdmissionStore.Service

  // A later team generation is valid only through an unrevoked, started tool anchor with the same tuple.
  const anchorFor = Effect.fn(function* (entry: Binding) {
    const invocation = entry.invocation
    const anchor = invocation.provisioningAdmissionID === undefined
      ? undefined
      : yield* admissions.get(entry.pluginID, invocation.provisioningAdmissionID)
    if (anchor?.revoked === true)
      return yield* new SubagentAdmissionStore.Conflict({ admissionID: entry.admissionID, reason: "Provisioning anchor revoked" })
    if (
      anchor === undefined || anchor.generation === undefined || anchor.invocation.kind !== "tool" ||
      anchor.invocation.team?.teamRunID !== invocation.teamRunID || anchor.invocation.team?.member !== invocation.member ||
      anchor.parentSessionID !== entry.parentSessionID || anchor.childSessionID !== entry.childSessionID || anchor.agent !== entry.agent
    )
      return yield* new SubagentAdmissionStore.Conflict({ admissionID: entry.admissionID, reason: "Unknown or mismatched provisioning anchor" })
    return anchor
  })

  const check = Effect.fn(function* (entry: SubagentAdmissionStore.Entry, phase: "start" | "resume" = "start") {
    const child = yield* sessions.get(entry.childSessionID)
    // Projected sessions report an omitted variant as "default"; compare with the same rule as Session model switching.
    const sameModel = child.model?.providerID === entry.model.providerID && child.model.id === entry.model.id &&
      (child.model.variant ?? "default") === (entry.model.variant ?? "default")
    // A resumed running generation retains the runtime model selected after its first authorization.
    if (child.parentID !== entry.parentSessionID || child.agent !== entry.agent || (phase === "start" && !sameModel))
      return yield* new SubagentAdmissionStore.Conflict({ admissionID: entry.admissionID, reason: "Prepared child binding changed" })
    if (entry.invocation.kind === "team") yield* anchorFor(entry)
    yield* permission.assertNotDenied({
      sessionID: entry.parentSessionID,
      agent: entry.invocation.agent,
      action: entry.permissionAction,
      resources: [entry.agent],
      ...(entry.invocation.kind === "tool" && entry.invocation.messageID !== undefined && entry.invocation.toolCallID !== undefined
        ? { source: { type: "tool" as const, messageID: entry.invocation.messageID, id: entry.invocation.toolCallID } }
        : {}),
      metadata: { pluginID: entry.pluginID, admissionID: entry.admissionID, invocation: entry.invocation },
    })
    // Accepted skills keep the parent's one approval; a later explicit deny on either side still wins.
    yield* Effect.forEach(entry.skills?.selections ?? [], (selection) =>
      Effect.forEach([
        { sessionID: entry.parentSessionID, agent: entry.invocation.agent },
        { sessionID: entry.childSessionID, agent: entry.agent },
      ], (actor) => permission.assertNotDenied({ ...actor, action: "skill", resources: [selection.skill] }), { discard: true }),
      { discard: true })
  })

  const prepare = Effect.fn(function* (pluginID: string, input: PrepareInput) {
    const recorded = yield* admissions.get(pluginID, input.admissionID)
    const invocation = input.invocation
    const sourceMessage = recorded === undefined && invocation.kind === "tool"
      ? (yield* sessions.context(input.parentSessionID)).find((message) => message.id === invocation.messageID)
      : undefined
    const sourceTool = sourceMessage?.type === "assistant" && invocation.kind === "tool"
      ? sourceMessage.content.find((part) => part.type === "tool" && part.id === invocation.toolCallID)
      : undefined
    const anchor = recorded === undefined && invocation.kind === "team"
      ? yield* admissions.get(pluginID, invocation.provisioningAdmissionID)
      : undefined
    const teamPath = invocation.kind === "team" || (invocation.kind === "tool" && invocation.team !== undefined)
    const bound = {
      pluginID,
      admissionID: input.admissionID,
      parentSessionID: input.parentSessionID,
      childSessionID: input.target.sessionID ?? Session.ID.make(`ses_${Hash.sha256(JSON.stringify([pluginID, input.admissionID]))}`),
      agent: input.agent,
      model: input.model,
      maxDepth: input.maxDepth,
      description: input.description,
      permissionAction: recorded?.permissionAction ?? anchor?.permissionAction ??
        (sourceTool?.type === "tool" && sourceTool.name === "call_omo_agent" ? "call_omo_agent" as const : "subagent" as const),
      invocation: input.invocation,
      targetKind: input.target.kind,
      ...(input.target.kind === "create" ? { location: input.target.location, permissions: input.target.permissions } : {}),
      status: "prepared" as const,
    }
    return yield* admissions.authorize(bound, Effect.gen(function* () {
      const previous = yield* admissions.get(pluginID, input.admissionID)
      if (previous !== undefined) {
        const original = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SubagentAdmissionStore.Entry))(JSON.stringify({ ...previous, status: "prepared", generation: undefined, start: undefined, output: undefined, error: undefined, skills: undefined, revoked: undefined, ownerCancelled: undefined }))
        const requested = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SubagentAdmissionStore.Entry))(JSON.stringify(bound))
        if (!isDeepStrictEqual(original, requested))
          return yield* new SubagentAdmissionStore.Conflict({ admissionID: input.admissionID, reason: "Admission binding changed" })
        if (previous.status !== "authorizing") return receipt(previous)
      }
      const parent = yield* sessions.get(input.parentSessionID)
      const agent = yield* agents.resolve(input.agent)
      // Primary targets need an authenticated team path or a command subtask (resolved against the live invocation below).
      if (agent === undefined || (agent.mode === "primary" && !teamPath && invocation.kind !== "command"))
        return yield* new SubagentAdmissionStore.Conflict({ admissionID: input.admissionID, reason: "Invalid subagent" })
      const available = yield* models.available()
      const model = available.find((model) => model.providerID === input.model.providerID && model.id === input.model.id)
      // "default" and an omitted variant both mean the model's default, the same rule as the binding check.
      const named = input.model.variant === undefined || input.model.variant === "default" ? undefined : input.model.variant
      if (model === undefined || (named !== undefined && !model.variants.some((variant) => variant.id === named)))
        return yield* new SubagentAdmissionStore.Conflict({ admissionID: input.admissionID, reason: "Unavailable subagent model or variant" })
      const ceiling = Config.latest(yield* config.entries(), "experimental")?.subagent_depth
      const limit = ceiling === undefined ? input.maxDepth : Math.min(input.maxDepth, ceiling)
      let depth = 0
      let ancestor = parent
      while (ancestor.parentID !== undefined) {
        depth++
        ancestor = yield* sessions.get(ancestor.parentID)
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || depth >= limit)
        return yield* new SubagentAdmissionStore.Conflict({ admissionID: input.admissionID, reason: "Subagent depth limit reached" })
      const actor = yield* agents.resolve(parent.agent)
      if (input.invocation.agent !== actor?.id)
        return yield* new SubagentAdmissionStore.Conflict({ admissionID: input.admissionID, reason: "Invocation agent does not own parent" })
      if (input.invocation.kind === "command") {
        const invocation = yield* commands.resolveInvocation(input.invocation)
        if (invocation.sessionID !== parent.id)
          return yield* new SubagentAdmissionStore.Conflict({ admissionID: input.admissionID, reason: "Command invocation belongs to another parent" })
        // Like the host's own command subtask, a primary child may only run the parent's agent; the host cannot see a
        // plugin command's configured agent, so any other primary is rejected.
        if (agent.mode === "primary" && !teamPath && agent.id !== actor?.id)
          return yield* new SubagentAdmissionStore.Conflict({ admissionID: input.admissionID, reason: "Command primary target must be the parent agent" })
      }
      if (input.invocation.kind === "tool" && recorded === undefined) {
        if (sourceTool === undefined)
          return yield* new SubagentAdmissionStore.Conflict({ admissionID: input.admissionID, reason: "Unknown tool invocation" })
        if (input.invocation.team !== undefined && (sourceTool.type !== "tool" || !teamTools.has(sourceTool.name)))
          return yield* new SubagentAdmissionStore.Conflict({ admissionID: input.admissionID, reason: "Team anchor requires a team provisioning tool" })
      }
      if (input.invocation.kind === "team") {
        if (input.target.kind !== "existing")
          return yield* new SubagentAdmissionStore.Conflict({ admissionID: input.admissionID, reason: "Team generation requires an existing member" })
        yield* anchorFor(bound)
      }
      yield* admissions.put({ ...bound, status: "authorizing" })
      const metadata = { pluginID, admissionID: input.admissionID, invocation: input.invocation }
      // A team generation reuses its anchor's approval; it only rechecks explicit denial.
      yield* (input.invocation.kind === "team"
        ? permission.assertNotDenied({ sessionID: parent.id, agent: input.invocation.agent, action: bound.permissionAction, resources: [agent.id], metadata })
        : permission.assert({
            sessionID: parent.id,
            agent: input.invocation.agent,
            action: bound.permissionAction,
            resources: [agent.id],
            save: [agent.id],
            ...(input.invocation.kind === "tool" ? { source: { type: "tool" as const, messageID: input.invocation.messageID, id: input.invocation.toolCallID } } : {}),
            metadata,
          })
      ).pipe(Effect.onExit((exit) => Exit.isFailure(exit)
        ? admissions.serialized(admissions.put({ ...bound, status: "cancelled" }))
        : Effect.void))
      return yield* admissions.serialized(Effect.gen(function* () {
      const latest = yield* admissions.get(pluginID, input.admissionID)
      if (latest?.status === "cancelled") return receipt(latest)
      if (input.invocation.kind === "team") yield* anchorFor(bound)
      const child = input.target.kind === "existing"
        ? yield* sessions.get(input.target.sessionID)
        : yield* sessions.create({
            id: bound.childSessionID,
            parentID: parent.id,
            location: input.target.location,
            title: input.description,
            agent: agent.id,
            model: input.model,
            permissions: input.target.permissions,
          })
      if (child.parentID !== parent.id)
        return yield* new SubagentAdmissionStore.Conflict({ admissionID: input.admissionID, reason: "Child belongs to another parent" })
      if (input.target.kind === "existing") {
        yield* sessions.switchAgent({ sessionID: child.id, agent: agent.id })
        yield* sessions.switchModel({ sessionID: child.id, model: input.model })
      }
      // The parent's unresolved preparation is durable before the prepared journal, so idle cannot slip between them.
      yield* inbox.prepareChild({ sessionID: parent.id, admissionID: SubagentAdmissionStore.key(pluginID, input.admissionID), childSessionID: child.id })
      yield* admissions.put(bound)
      return receipt(bound)
      }))
    }))
  })
  return { prepare, check }
})

export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentAdmission") {}

export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.location> = Node.makeLocationNode({
  service: Service,
  layer: Layer.effect(Service, make),
  deps: [Session.node, SessionInbox.node, Agent.node, Model.node, Permission.node, Config.node, Command.node, SubagentAdmissionStore.node],
})
