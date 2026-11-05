export * as SessionSkill from "./skill.js"

import { createHash } from "node:crypto"
import type { Agent } from "@opencode/schema/agent"
import { Event } from "@opencode/schema/event"
import type { Permission as PermissionSchema } from "@opencode/schema/permission"
import type { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Skill as SkillSchema } from "@opencode/schema/skill"
import { Effect, Option, Schema } from "effect"
import { Agent as AgentService } from "../agent.js"
import { Bus } from "../bus.js"
import { KeyedMutex } from "../effect/keyed-mutex.js"
import { Instance } from "../instance/service.js"
import { Permission } from "../permission.js"
import { PluginHooks } from "../plugin/hooks.js"
import { Plugin } from "../plugin/service.js"
import { Skill } from "../skill.js"
import { FSUtil } from "@opencode/util/fs-util"
import { SkillNotFoundError } from "./error.js"
import { SessionEvent } from "./event.js"
import { SessionStore } from "./store.js"

export type Activation = SessionMessage.SkillActivation

export interface PrepareInput {
  readonly session: Session.Info
  readonly activationID: SkillSchema.ActivationID
  readonly source: SessionMessage.SkillActivationSource
  readonly skill: Skill.ID
  readonly arguments?: string
  readonly authorization?: {
    readonly session: Session.Info
    readonly agent: Agent.ID
  }
}

export class ActivationDeniedError extends Schema.TaggedError<ActivationDeniedError>()("SessionSkill.ActivationDenied", {
  skill: Skill.ID,
  reason: Schema.String,
}) {}

export class NotAcceptedError extends Schema.TaggedError<NotAcceptedError>()("SessionSkill.NotAccepted", {
  sessionID: Schema.String,
  skill: Skill.ID,
}) {}

export class ActivationConflictError extends Schema.TaggedError<ActivationConflictError>()(
  "SessionSkill.ActivationConflict",
  { activationID: SkillSchema.ActivationID },
) {}

const locks = KeyedMutex.makeUnsafe<SkillSchema.ActivationID>()
const batchLocks = KeyedMutex.makeUnsafe<SessionMessage.ID>()
const jsonMetadata = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))

export const get = Effect.fn("SessionSkill.get")(function* (input: { session: Session.Info; skill: Skill.ID }) {
  const instances = yield* Instance.Service
  const skills = yield* Plugin.awaitActivation.pipe(Effect.andThen(Skill.Service), instances.provide(input.session))
  const skill = yield* skills.get(input.skill)
  if (!skill) return yield* new SkillNotFoundError({ skill: input.skill })
  return skill
})

export const prepare = Effect.fn("SessionSkill.prepare")(function* (input: PrepareInput) {
  const instances = yield* Instance.Service
  return yield* Effect.gen(function* () {
    yield* Plugin.awaitActivation
    const agents = yield* AgentService.Service
    const fs = yield* FSUtil.Service
    const hooks = yield* PluginHooks.Service
    const skills = yield* Skill.Service
    const agent = (yield* agents.select(input.session.agent)).id
    const skill = yield* skills.get(input.skill)
    if (!skill) return yield* new SkillNotFoundError({ skill: input.skill })
    // A delegated activation asks the authorizing parent once. The child's own rules can still deny, but never ask.
    if (input.authorization)
      yield* Effect.gen(function* () {
        const permission = yield* Permission.Service
        yield* permission.assertNotDenied({
          action: "skill",
          resources: [skill.id],
          sessionID: input.session.id,
          agent,
        })
      })
    const assertion = Effect.gen(function* () {
      const permission = yield* Permission.Service
      yield* permission.assert({
        action: "skill",
        resources: [skill.id],
        save: [skill.id],
        sessionID: input.authorization?.session.id ?? input.session.id,
        agent: input.authorization?.agent ?? agent,
        source:
          input.authorization || input.source.kind !== "tool"
            ? undefined
            : ({ type: "tool", messageID: input.source.messageID, id: input.source.callID } satisfies PermissionSchema.Source),
      })
    })
    yield* input.authorization ? assertion.pipe(instances.provide(input.authorization.session)) : assertion
    const files = yield* skills.files(skill.id)
    const expanded = yield* Skill.prepare(fs, skill, files).pipe(Effect.orDie)
    const revision = createHash("sha256")
      .update(JSON.stringify([skill, Array.from(files ?? []).toSorted(([a], [b]) => a.localeCompare(b))]))
      .digest("hex")
    const identity = {
      activationID: input.activationID,
      sessionID: input.session.id,
      agent,
      source: structuredClone(input.source),
      skill: structuredClone(skill),
      arguments: input.arguments,
    }
    const event = {
      ...identity,
      source: structuredClone(identity.source),
      skill: structuredClone(identity.skill),
      content: expanded.output,
      metadata: {} as Record<string, Schema.Json>,
      decision: { allow: true } as { allow: true } | { allow: false; reason: string },
    }
    yield* hooks.trigger("skill", "experimental.activate", event)
    if (!event.decision.allow)
      return yield* new ActivationDeniedError({ skill: skill.id, reason: event.decision.reason })
    return {
      ...identity,
      revision,
      content: event.content,
      metadata: event.metadata,
    } satisfies Activation
  }).pipe(instances.provide(input.session))
})

export const activate = Effect.fn("SessionSkill.activate")(function* (input: PrepareInput) {
  return yield* locks.withLock(input.activationID)(
    Effect.gen(function* () {
      const existing = yield* accepted(input.session.id, input.activationID)
      if (existing) {
        if (
          existing.skill.id !== input.skill ||
          existing.arguments !== input.arguments ||
          JSON.stringify(existing.source) !== JSON.stringify(input.source)
        )
          return yield* new ActivationConflictError({ activationID: input.activationID })
        return existing
      }
      const activation = yield* prepare(input)
      const bus = yield* Bus.Service
      yield* bus.publish(SessionEvent.Skill.Activated, activation, {
        id: Event.ID.make(input.activationID.replace(/^ska_/, "evt_")),
      })
      return activation
    }),
  )
})

export interface BatchInput {
  /** The child Session whose prompt will consume the accepted snapshots. */
  readonly session: Session.Info
  readonly promptID: SessionMessage.ID
  readonly items: ReadonlyArray<{
    readonly activationID: SkillSchema.ActivationID
    readonly skill: Skill.ID
    readonly arguments?: string
  }>
  readonly authorization: { readonly session: Session.Info; readonly agent: Agent.ID }
}

/**
 * Accepts a delegated prompt's skill selections as one unit: every selection is authorized and expanded before
 * any snapshot is written, so a denial leaves no partial batch. Binds no MCP server and wakes nothing.
 */
export const acceptBatch = Effect.fn("SessionSkill.acceptBatch")(function* (input: BatchInput) {
  return yield* batchLocks.withLock(input.promptID)(
    Effect.gen(function* () {
      const requests = input.items.map((item, selectionIndex) => ({
        ...item,
        source: { kind: "prompt" as const, messageID: input.promptID, selectionIndex },
      }))
      const stored = yield* activations(input.session.id)
      const existing = requests.map((request) => stored.find((item) => item.activationID === request.activationID))
      if (existing.some((item) => item !== undefined)) {
        const accepted = existing.flatMap((item, index) => (item && sameSelection(item, requests[index]!) ? [item] : []))
        if (accepted.length === requests.length) return accepted
        return yield* new ActivationConflictError({
          activationID: requests[existing.findIndex((item) => item !== undefined)]!.activationID,
        })
      }
      const prepared = yield* Effect.forEach(requests, (request) =>
        prepare({
          session: input.session,
          activationID: request.activationID,
          source: request.source,
          skill: request.skill,
          arguments: request.arguments,
          authorization: input.authorization,
        }),
      )
      const [first, ...rest] = prepared
      if (!first) return prepared
      const bus = yield* Bus.Service
      yield* bus.publishAll([activated(first), ...rest.map(activated)])
      return prepared
    }),
  )
})

const activated = (activation: Activation) =>
  [
    SessionEvent.Skill.Activated,
    activation,
    { id: Event.ID.make(activation.activationID.replace(/^ska_/, "evt_")) },
  ] as const

function sameSelection(
  activation: Activation,
  request: { readonly skill: Skill.ID; readonly arguments?: string; readonly source: Activation["source"] },
) {
  return (
    activation.skill.id === request.skill &&
    activation.arguments === request.arguments &&
    JSON.stringify(activation.source) === JSON.stringify(request.source)
  )
}

export const activations = Effect.fn("SessionSkill.activations")(function* (sessionID: Session.ID) {
  const store = yield* SessionStore.Service
  return (yield* store.messages({ sessionID, type: "skill", order: "asc" })).flatMap((message) => {
    const activation = fromMessage(sessionID, message)
    return activation ? [activation] : []
  })
})

export const activation = Effect.fn("SessionSkill.activation")(function* (input: {
  sessionID: Session.ID
  skillID: Skill.ID
}) {
  const found = (yield* activations(input.sessionID)).findLast((item) => item.skill.id === input.skillID)
  if (!found) return yield* new NotAcceptedError({ sessionID: input.sessionID, skill: input.skillID })
  return found
})

export const accepted = Effect.fn("SessionSkill.accepted")(function* (
  sessionID: Session.ID,
  activationID: SkillSchema.ActivationID,
) {
  return (yield* activations(sessionID)).find((item) => item.activationID === activationID)
})

function fromMessage(sessionID: Session.ID, message: SessionMessage.Info): Activation | undefined {
  if (message.type !== "skill") return
  if (!message.activationID || !message.agent || !message.source || !message.definition || !message.revision) return
  const metadata = jsonMetadata(message.metadata ?? {})
  if (Option.isNone(metadata)) return
  return {
    activationID: message.activationID,
    sessionID,
    agent: message.agent,
    source: message.source,
    skill: message.definition,
    arguments: message.arguments,
    revision: message.revision,
    content: message.text,
    metadata: metadata.value,
  }
}
