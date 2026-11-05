export * as SessionInterruptJournal from "./interrupt-journal.js"

import { Deferred, Effect, Exit, Option, Schema } from "effect"
import type { KV } from "../kv.js"
import type { SessionMessage } from "./message.js"
import type { SessionSchema } from "./schema.js"

export type Owner = { readonly pluginID: string; readonly lifetime: string }
export type Admission = {
  readonly check: Effect.Effect<boolean>
  readonly commit: () => Effect.Effect<void>
  readonly signal: Effect.Effect<void>
}
const Record = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  pluginID: Schema.String,
  lifetime: Schema.String,
  generation: Schema.NullOr(Schema.String),
  boundaryID: Schema.NullOr(Schema.String),
  phase: Schema.Literals(["held", "committed", "settled", "failed", "cancelled"]),
  error: Schema.NullOr(Schema.String),
})
type Record = typeof Record.Type
export type Attempt = {
  record: Record
  readonly done: Deferred.Deferred<void>
}
const key = (sessionID: string) => `native-interrupt:${sessionID}`

export const make = Effect.fn(function* (kv: KV.Interface) {
  const attempts = new Map<string, Attempt>()
  const abandoned: Attempt[] = []
  let after: string | undefined
  do {
    const page = yield* kv.scan({ prefix: "native-interrupt:", after })
    for (const entry of page.entries) {
      const decoded = Schema.decodeUnknownOption(Record)(entry.value)
      if (Option.isNone(decoded)) continue
      const record = decoded.value
      const done = Deferred.makeUnsafe<void>()
      if (record.phase !== "held") Deferred.doneUnsafe(done, Exit.succeed(undefined))
      const attempt = { record, done }
      attempts.set(record.sessionID, attempt)
      if (decoded.value.phase === "held") abandoned.push(attempt)
    }
    after = page.next
  } while (after !== undefined)
  const persist = (attempt: Attempt, record: Record) => kv.set(key(record.sessionID), record).pipe(
    Effect.andThen(Effect.sync(() => { attempt.record = record })),
  )
  const finish = (attempt: Attempt, phase: "failed" | "cancelled" | "settled", error: string) => Effect.gen(function* () {
    if (attempt.record.phase !== "held") return
    yield* persist(attempt, { ...attempt.record, phase, error })
    if (phase !== "cancelled") yield* Deferred.succeed(attempt.done, undefined)
  })
  return {
    all: () => [...attempts.values()],
    get: (sessionID: string) => attempts.get(sessionID),
    forget: (attempt: Attempt) => kv.remove(key(attempt.record.sessionID)).pipe(Effect.andThen(Effect.sync(() => {
      if (attempts.get(attempt.record.sessionID) === attempt) attempts.delete(attempt.record.sessionID)
    }))),
    begin: (sessionID: SessionSchema.ID, owner: Owner, generation?: string) => Effect.gen(function* () {
      const previous = attempts.get(sessionID)?.record
      if (previous?.phase === "held" || (generation !== undefined && previous?.generation === generation && (previous.phase === "failed" || previous.phase === "cancelled"))) return undefined
      const record: Record = { id: crypto.randomUUID(), sessionID, ...owner, generation: generation ?? null, boundaryID: null, phase: "held", error: null }
      const attempt: Attempt = { record, done: Deferred.makeUnsafe<void>() }
      yield* kv.set(key(sessionID), record)
      attempts.set(sessionID, attempt)
      return attempt
    }),
    boundary: (attempt: Attempt, boundaryID: SessionMessage.ID) => persist(attempt, { ...attempt.record, boundaryID }),
    commit: (attempt: Attempt) => kv.set(key(attempt.record.sessionID), { ...attempt.record, phase: "committed" }),
    committed: (attempt: Attempt) => Effect.sync(() => { attempt.record = { ...attempt.record, phase: "committed" } }).pipe(
      Effect.andThen(Deferred.succeed(attempt.done, undefined)), Effect.asVoid,
    ),
    signal: (attempt: Attempt) => Deferred.succeed(attempt.done, undefined).pipe(Effect.asVoid),
    wait: (sessionID: SessionSchema.ID, generation?: string) => Effect.gen(function* () {
      const attempt = attempts.get(sessionID)
      if (!attempt || attempt.record.generation !== (generation ?? null)) return undefined
      yield* Deferred.await(attempt.done)
      switch (attempt.record.phase) {
        case "committed": return "committed" as const
        case "settled": return undefined
        case "held":
        case "failed":
        case "cancelled": return yield* Effect.fail(new Error(attempt.record.error ?? "Recovery cancelled"))
      }
    }),
    finish,
    abandoned: () => abandoned,
  }
})
