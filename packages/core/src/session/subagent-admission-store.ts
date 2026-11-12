export * as SubagentAdmissionStore from "./subagent-admission-store.js"

import { Context, Deferred, Effect, Exit, Layer, Schema, SynchronizedRef } from "effect"
import type { Receipt } from "@opencode/plugin/subagent"
import { isDeepStrictEqual } from "node:util"
import { Node } from "@opencode/util/effect/app-node"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Permission } from "@opencode/schema/permission"
import { PromptInput } from "@opencode/schema/prompt-input"
import { Location } from "@opencode/schema/location"
import { Skill } from "@opencode/schema/skill"
import { KV } from "../kv.js"
import { SessionSchema } from "./schema.js"
import { SessionMessage } from "./message.js"

const Invocation = Schema.Struct({
  agent: Agent.ID,
  kind: Schema.Literals(["tool", "command", "team"]),
  messageID: Schema.optionalKey(SessionMessage.ID),
  toolCallID: Schema.optionalKey(Schema.String),
  invocationID: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  teamRunID: Schema.optionalKey(Schema.String),
  member: Schema.optionalKey(Schema.String),
  team: Schema.optionalKey(Schema.Struct({ teamRunID: Schema.String, member: Schema.String })),
  provisioningAdmissionID: Schema.optionalKey(Schema.String),
})

const Start = Schema.Struct({
  promptID: SessionMessage.ID,
  prompt: PromptInput.Prompt,
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  delivery: Schema.Literals(["queue", "steer"]),
  mode: Schema.Literals(["foreground", "background"]),
  completion: Schema.Literals(["parent", "none"]),
})

// The ordered skill batch is journaled before activation so a changed retry is rejected.
const Skills = Schema.Struct({
  promptID: SessionMessage.ID,
  selections: Schema.Array(Schema.Struct({
    activationID: Skill.ActivationID,
    skill: Skill.ID,
    arguments: Schema.optionalKey(Schema.String),
  })),
})

export const Entry = Schema.Struct({
  pluginID: Schema.String,
  admissionID: Schema.String,
  parentSessionID: SessionSchema.ID,
  childSessionID: SessionSchema.ID,
  agent: Agent.ID,
  model: Model.Ref,
  maxDepth: Schema.Number,
  description: Schema.String,
  permissionAction: Schema.Literals(["subagent", "call_omo_agent"]),
  invocation: Invocation,
  targetKind: Schema.Literals(["create", "existing"]),
  location: Schema.optionalKey(Location.Ref),
  permissions: Schema.optionalKey(Permission.Ruleset),
  status: Schema.Literals(["authorizing", "prepared", "accepted", "running", "completed", "error", "cancelled"]),
  generation: Schema.optionalKey(Schema.String),
  start: Schema.optionalKey(Start),
  output: Schema.optionalKey(Schema.String),
  outputModel: Schema.optionalKey(Model.Ref),
  error: Schema.optionalKey(Schema.String),
  skills: Schema.optionalKey(Skills),
  // Revocation removes future team authority without rewriting the historical outcome.
  revoked: Schema.optionalKey(Schema.Literal(true)),
  // Set when the owning plugin cancelled this generation; its completion then wakes no parent.
  ownerCancelled: Schema.optionalKey(Schema.Literal(true)),
})
export type Entry = typeof Entry.Type

export class Conflict extends Schema.TaggedError<Conflict>()("SubagentAdmission.Conflict", {
  admissionID: Schema.String,
  reason: Schema.String,
}) {}

const prefix = "native-subagent:"
export const key = (pluginID: string, admissionID: string) =>
  `${prefix}${encodeURIComponent(pluginID)}:${encodeURIComponent(admissionID)}`

export const make = Effect.gen(function* () {
  const kv = yield* KV.Service
  const lock = yield* SynchronizedRef.make(undefined)
  const preparing = new Map<string, {
    readonly admissionKey: string
    readonly binding: Entry
    readonly result: Deferred.Deferred<Receipt, unknown>
    readonly cancelled: Deferred.Deferred<Receipt>
  }>()
  const get = Effect.fn(function* (pluginID: string, admissionID: string) {
    const value = yield* kv.get(key(pluginID, admissionID))
    if (value === undefined) return undefined
    return yield* Schema.decodeUnknownEffect(Entry)(value).pipe(Effect.orDie)
  })
  const put = (entry: Entry) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(Entry))(JSON.stringify(entry)).pipe(
      Effect.flatMap(Schema.encodeEffect(Entry)),
      Effect.flatMap((value) => Schema.decodeUnknownEffect(Schema.Json)(value)),
      Effect.flatMap((value) => kv.set(key(entry.pluginID, entry.admissionID), value)),
      Effect.orDie,
    )
  const list = Effect.fn(function* (pluginID?: string) {
    const entries: Entry[] = []
    let after: string | undefined
    do {
      const page = yield* kv.scan({ prefix: pluginID === undefined ? prefix : `${prefix}${encodeURIComponent(pluginID)}:`, after })
      for (const entry of page.entries)
        entries.push(yield* Schema.decodeUnknownEffect(Entry)(entry.value).pipe(Effect.orDie))
      after = page.next
    } while (after !== undefined)
    return entries
  })
  return {
    get,
    put,
    list,
    authorize: <E, R>(entry: Entry, effect: Effect.Effect<Receipt, E, R>, operation: "prepare" | "skills" = "prepare") =>
      Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        const admissionKey = key(entry.pluginID, entry.admissionID)
        const id = `${admissionKey}:${operation}`
        const binding = entry
        const pending = preparing.get(id)
        if (pending !== undefined) {
          if (!isDeepStrictEqual(pending.binding, binding)) return yield* new Conflict({ admissionID: entry.admissionID, reason: "Admission binding changed" })
          return yield* restore(Deferred.await(pending.result))
        }
        const result = yield* Deferred.make<Receipt, unknown>()
        const cancelled = yield* Deferred.make<Receipt>()
        preparing.set(id, { admissionKey, binding, result, cancelled })
        const exit = yield* restore(Effect.raceFirst(effect, Deferred.await(cancelled))).pipe(Effect.exit)
        yield* Deferred.done(result, exit)
        preparing.delete(id)
        if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
        return exit.value
      })),
    cancelAuthorization: (pluginID: string, admissionID: string, receipt: Receipt) => Effect.forEach(
      [...preparing.values()].filter((operation) => operation.admissionKey === key(pluginID, admissionID)),
      (operation) => Deferred.succeed(operation.cancelled, receipt),
      { discard: true },
    ),
    serialized: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      SynchronizedRef.modifyEffect(lock, () => effect.pipe(Effect.map((value) => [value, undefined] as const))),
  }
})

export class Service extends Context.Service<Service, Effect.Success<typeof make>>() ("@opencode/SubagentAdmissionStore") {}

export const node = Node.makeGlobalNode({ service: Service, layer: Layer.effect(Service, make), deps: [KV.node] })
