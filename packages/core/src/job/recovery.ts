import { Schema } from "effect"
import { SessionSchema } from "../session/schema.js"

export const RecoverySchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("shell"),
    sessionID: SessionSchema.ID,
    shellID: Schema.String,
    command: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("subagent"),
    parentSessionID: SessionSchema.ID,
    childSessionID: SessionSchema.ID,
    agent: Schema.String,
    description: Schema.String,
    pluginID: Schema.optionalKey(Schema.String),
    admissionID: Schema.optionalKey(Schema.String),
    generation: Schema.optionalKey(Schema.String),
    completion: Schema.optionalKey(Schema.Literals(["parent", "none"])),
  }),
  Schema.Struct({
    kind: Schema.Literal("image"),
    sessionID: SessionSchema.ID,
    path: Schema.String,
    model: Schema.String,
  }),
])

export type Recovery = typeof RecoverySchema.Type
