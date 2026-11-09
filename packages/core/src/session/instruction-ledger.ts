import { and, asc, eq } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import type { Database } from "../database/database.js"
import { SessionHistory } from "./history.js"
import type { SessionMessage } from "./message.js"
import type { SessionSchema } from "./schema.js"
import { SessionMessageTable } from "./sql.js"

export const Metadata = Schema.Struct({
  instruction: Schema.Struct({
    paths: Schema.Array(Schema.String),
    retained: Schema.optional(Schema.Literal(true)),
  }),
})

export const retainedPaths = Effect.fn("SessionInstructions.retainedPaths")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
) {
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "synthetic")))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const messages = yield* Effect.forEach(rows, SessionHistory.decodeMessageRow)
  return new Set(
    messages.flatMap((message) => {
      if (message.type !== "synthetic") return []
      const metadata = Option.getOrUndefined(Schema.decodeUnknownOption(Metadata)(message.metadata))
      return metadata?.instruction.retained ? metadata.instruction.paths : []
    }),
  )
})

export const previouslyInjected = Effect.fn("SessionInstructions.previouslyInjected")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
) {
  const history = yield* SessionHistory.synthetics(db, sessionID)
  return new Set(
    history
      .filter((message): message is SessionMessage.Synthetic => message.type === "synthetic")
      .flatMap(
        (message) =>
          Option.getOrUndefined(Schema.decodeUnknownOption(Metadata)(message.metadata))?.instruction.paths ?? [],
      ),
  )
})
