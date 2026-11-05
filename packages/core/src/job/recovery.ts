import { Schema } from "effect"
import { SessionSchema } from "../session/schema.js"

const Shell = Schema.Struct({
  kind: Schema.Literal("shell"),
  sessionID: SessionSchema.ID,
  shellID: Schema.String,
  command: Schema.String,
})
const Image = Schema.Struct({
  kind: Schema.Literal("image"),
  sessionID: SessionSchema.ID,
  path: Schema.String,
  model: Schema.String,
})
const subagent = {
  kind: Schema.Literal("subagent"),
  childSessionID: SessionSchema.ID,
  agent: Schema.String,
  description: Schema.String,
}

const OutstandingItem = Schema.Union([
  Shell,
  Image,
  Schema.Struct({ ...subagent, sessionID: SessionSchema.ID, wakes: Schema.optionalKey(Schema.Boolean) }),
])
export type OutstandingItem = typeof OutstandingItem.Type

export const RecoverySchema = Schema.Union([
  Shell,
  Image,
  Schema.Struct({
    ...subagent,
    parentSessionID: SessionSchema.ID,
    outstanding: Schema.optionalKey(Schema.Array(OutstandingItem)),
    pluginID: Schema.optionalKey(Schema.String),
    admissionID: Schema.optionalKey(Schema.String),
    generation: Schema.optionalKey(Schema.String),
    completion: Schema.optionalKey(Schema.Literals(["parent", "none"])),
  }),
])

export type Recovery = typeof RecoverySchema.Type
