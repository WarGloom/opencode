export * as Command from "./command.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"
import { ascending } from "./identifier.js"
import { optional, statics } from "./schema.js"

const Updated = ephemeral({ type: "command.updated", schema: {} })

export const InvocationID = Schema.String.check(Schema.isStartingWith("cmdinv_")).pipe(
  Schema.brand("Command.InvocationID"),
  Schema.annotate({ identifier: "Command.InvocationID" }),
  statics((schema) => ({ create: () => schema.make("cmdinv_" + ascending()) })),
)
export type InvocationID = typeof InvocationID.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.String.pipe(optional),
}).annotate({ identifier: "Command.Info" })

export const Event = {
  Updated,
  Definitions: inventory(Updated),
}
