export * as SubagentSteerBinding from "./subagent-steer-binding.js"

import { Schema } from "effect"
import { Hash } from "@opencode/util/hash"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"

export const Binding = Schema.Struct({
  pluginID: Schema.String,
  admissionID: Schema.String,
  parentSessionID: SessionSchema.ID,
  generation: Schema.String,
  messageID: SessionMessage.ID,
  toolCallID: Schema.String,
})
export type Binding = typeof Binding.Type

export const promptID = (binding: Pick<Binding, "pluginID" | "messageID" | "toolCallID">) =>
  SessionMessage.ID.make(`msg_${Hash.sha256(JSON.stringify([binding.pluginID, "steer", binding.messageID, binding.toolCallID]))}`)

export const decode = Schema.decodeUnknownOption(Binding)
