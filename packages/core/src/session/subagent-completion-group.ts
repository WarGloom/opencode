import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database.js"
import { KVTable } from "../kv/sql.js"
import type { SessionSchema } from "./schema.js"

export const Name = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[\p{L}\p{N}_.:-]+$/u),
)
export const Reference = Schema.Struct({
  name: Name,
  order: Schema.Number,
  run: Schema.String,
  bypass: Schema.optionalKey(Schema.Boolean),
})
export type Reference = typeof Reference.Type
const Member = Schema.Struct({
  ...Reference.fields,
  child: Schema.String,
  terminal: Schema.Boolean,
  bypass: Schema.Boolean,
})
const State = Schema.Array(Member)
type Member = typeof Member.Type

export function make(db: Database.Interface["db"]) {
  const key = (parent: SessionSchema.ID) => "subagent-completion-groups:" + parent
  const load = (parent: SessionSchema.ID) =>
    db
      .select({ value: KVTable.value })
      .from(KVTable)
      .where(eq(KVTable.key, key(parent)))
      .get()
      .pipe(
        Effect.orDie,
        Effect.map((row) => (row ? Schema.decodeUnknownSync(State)(row.value) : [])),
      )
  const save = (parent: SessionSchema.ID, members: readonly Member[]) =>
    db
      .insert(KVTable)
      .values({ key: key(parent), value: members })
      .onConflictDoUpdate({ target: KVTable.key, set: { value: members } })
      .run()
      .pipe(Effect.orDie, Effect.asVoid)

  const register = Effect.fnUntraced(function* (
    parent: SessionSchema.ID,
    child: SessionSchema.ID,
    group: string | undefined,
    run: string,
  ) {
    const members = yield* load(parent)
    const previous = members.find((member) => member.child === child)
    if (previous?.run === run) return previous
    const name = group ?? previous?.name
    if (name === undefined) return undefined
    const peers = members.filter((member) => member.name === name && member.child !== child)
    const bypass = peers.some((peer) => !peer.terminal && peer.bypass)
    const order = previous?.name === name ? previous.order : 1 + Math.max(0, ...peers.map((peer) => peer.order))
    const next = { name, order, run, child, terminal: false, bypass }
    yield* save(parent, [...members.filter((member) => member.child !== child), next])
    return next
  })

  const lookup = Effect.fnUntraced(function* (parent: SessionSchema.ID, child: SessionSchema.ID, run?: string) {
    const member = (yield* load(parent)).find(
      (member) => member.child === child && (run === undefined ? !member.terminal : member.run === run),
    )
    return member && { name: member.name, order: member.order, run: member.run, bypass: member.bypass }
  })

  const finish = Effect.fnUntraced(function* (parent: SessionSchema.ID, group: Reference, failed: boolean) {
    return yield* db
      .transaction(
        () =>
          Effect.gen(function* () {
            const members = yield* load(parent)
            const member = members.find((value) => value.run === group.run && value.name === group.name)
            if (!member) return true
            if (member.terminal) return false
            const others = members.some(
              (value) => value.name === group.name && value.run !== group.run && !value.terminal,
            )
            yield* save(
              parent,
              members.map((value) => {
                if (value === member) return { ...value, terminal: true }
                if (failed && value.name === group.name && !value.terminal) return { ...value, bypass: true }
                return value
              }),
            )
            return failed || member.bypass || !others
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.orDie)
  })
  return { register, lookup, finish }
}
