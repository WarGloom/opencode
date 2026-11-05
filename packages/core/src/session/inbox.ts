export * as SessionInbox from "./inbox.js"

import { and, asc, desc, eq, or } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Event } from "@opencode/schema/event"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import {
  Compaction,
  CompactionPayload,
  Delivery,
  Info,
  Item,
  MediaInfo,
  MediaUser,
  MediaUserPayload,
  Move,
  MovePayload,
  Synthetic,
  SyntheticPayload,
  User,
  UserPayload,
} from "@opencode/schema/session-inbox"
import { Database } from "../database/database.js"
import { Bus } from "../bus.js"
import { KeyedMutex } from "../effect/keyed-mutex.js"
import { SessionEvent } from "./event.js"
import { SessionBlob } from "./blob.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { SessionStored } from "./stored.js"
import { SessionChildPreparationTable, SessionInboxTable, SessionMessageTable, SessionTable } from "./sql.js"
import { SessionHistory } from "./history.js"
import type { Activation } from "./skill.js"

type DatabaseService = Database.Interface["db"]

export {
  Compaction,
  CompactionPayload,
  Delivery,
  Info,
  Item,
  MediaInfo,
  MediaUser,
  MediaUserPayload,
  Move,
  MovePayload,
  Synthetic,
  SyntheticPayload,
  User,
  UserPayload,
}

/**
 * Which pending input `promote` may consume: "steer" promotes steers only (a step
 * boundary mid-work), while "input" also allows one queued input when no steers are
 * waiting (the idle boundary, where the Session picks up fresh work).
 */
export type Promotable = "input" | "steer"

const decodeUser = Schema.decodeUnknownSync(UserPayload)
const decodeMediaUser = Schema.decodeUnknownSync(MediaUserPayload)
const decodeStoredUser = Schema.decodeUnknownSync(SessionStored.UserPayload)
const encodeStoredUser = Schema.encodeSync(SessionStored.UserPayload)
const decodeSynthetic = Schema.decodeUnknownSync(SyntheticPayload)
const encodeSynthetic = Schema.encodeSync(SyntheticPayload)
const decodeCompaction = Schema.decodeUnknownSync(CompactionPayload)
const encodeCompaction = Schema.encodeSync(CompactionPayload)
const decodeMove = Schema.decodeUnknownSync(MovePayload)
const encodeMove = Schema.encodeSync(MovePayload)
const inboxLocks = KeyedMutex.makeUnsafe<SessionSchema.ID>()
type PendingRef = { readonly id: SessionMessage.ID; readonly sessionID: SessionSchema.ID }
export type IdleAdmission = "admitted" | "duplicate" | "stale"
export type IdleBoundary = {
  readonly admit: (input: {
    readonly id: SessionMessage.ID
    readonly text: string
    readonly description?: string
  }) => Effect.Effect<IdleAdmission>
}

export const serialized = <A, E, R>(sessionID: SessionSchema.ID, effect: Effect.Effect<A, E, R>) =>
  inboxLocks.withLock(sessionID)(effect)

export class LifecycleConflict extends Schema.TaggedError<LifecycleConflict>()("SessionInbox.LifecycleConflict", {
  id: SessionMessage.ID,
}) {}

export class ChildPreparationConflictError extends Schema.TaggedError<ChildPreparationConflictError>()(
  "SessionInbox.ChildPreparationConflict",
  { admissionID: Schema.String },
) {}

function matches<Type extends Item["type"]>(
  stored: Info,
  request: PendingRef & { readonly type: Type },
): stored is Extract<Info, { readonly type: Type }> {
  return stored.sessionID === request.sessionID && stored.type === request.type
}

const fromRow = (row: typeof SessionInboxTable.$inferSelect): Info => {
  const base = {
    id: row.id,
    sessionID: row.session_id,
    time: { created: DateTime.makeUnsafe(row.time_created) },
  }
  if (row.type === "compaction")
    return Compaction.make({
      ...base,
      type: "compaction",
      payload: decodeCompaction(row.payload),
      delivery: row.delivery,
    })
  if (row.type === "move")
    return Move.make({ ...base, type: "move", payload: decodeMove(row.payload), delivery: row.delivery })
  if (row.type === "user")
    return User.make({
      ...base,
      type: "user",
      payload: decodeUser(row.payload),
      delivery: row.delivery,
    })
  if (row.type === "synthetic")
    return Synthetic.make({
      ...base,
      type: "synthetic",
      payload: decodeSynthetic(row.payload),
      delivery: row.delivery,
    })
  throw new LifecycleConflict({ id: base.id })
}

export const find = Effect.fn("SessionInbox.find")(function* (db: DatabaseService, id: SessionMessage.ID) {
  const row = yield* db.select().from(SessionInboxTable).where(eq(SessionInboxTable.id, id)).get().pipe(Effect.orDie)
  if (row === undefined) return undefined
  const [hydrated] = yield* SessionBlob.hydrateInbox(db, [row])
  return hydrated && fromRow(hydrated)
})

const promotedFromMessage = Effect.fn("SessionInbox.promotedFromMessage")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  id: SessionMessage.ID,
  delivery: Delivery,
) {
  const row = yield* db
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, id))
    .get()
    .pipe(Effect.orDie)
  if (row === undefined) return undefined
  if (row.session_id !== sessionID || (row.type !== "user" && row.type !== "synthetic"))
    return yield* new LifecycleConflict({ id })
  const [message] = yield* SessionHistory.decodeMessageRows(db, [row]).pipe(Effect.orDie)
  if (!message) return undefined
  const base = { id, sessionID, time: { created: message.time.created }, delivery }
  if (message.type === "user")
    return User.make({
      ...base,
      type: "user",
      payload: UserPayload.make({
        text: message.text,
        files: message.files,
        agents: message.agents,
        skills: message.skills,
        metadata: message.metadata,
      }),
    })
  if (message.type === "synthetic")
    return Synthetic.make({
      ...base,
      type: "synthetic",
      payload: SyntheticPayload.make({
        text: message.text,
        description: message.description,
        metadata: message.metadata,
      }),
    })
})

export type Interface = Effect.Success<ReturnType<typeof make>>

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionInbox") {}

export const make = Effect.fn("SessionInbox.make")(function* () {
  const database = yield* Database.Service
  const db = database.db
  const bus = yield* Bus.Service

  /** First admission wins for matching Session and type, without preparing a new payload. */
  const reconcile = Effect.fn("SessionInbox.reconcile")(function* <Type extends Item["type"]>(request: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly type: Type
    readonly delivery: Delivery
  }) {
    const existing =
      (yield* find(db, request.id)) ?? (yield* promotedFromMessage(db, request.sessionID, request.id, request.delivery))
    if (existing === undefined) return undefined
    if (existing.type === "compaction" || !matches(existing, request))
      return yield* new LifecycleConflict({ id: request.id })
    return existing
  })

  const admit = Effect.fn("SessionInbox.admit")(function* <Type extends Item["type"]>(request: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly item: Item & { readonly type: Type }
    readonly expectedSequence?: number
    readonly activations?: ReadonlyArray<Activation>
  }) {
    const existing = yield* reconcile({ ...request, type: request.item.type, delivery: request.item.delivery })
    if (existing !== undefined) return existing
    const [first, ...rest] = request.activations ?? []
    const admitted = yield* (first
      ? bus
          .publishAll([
            [
              SessionEvent.Skill.Activated,
              first,
              { id: Event.ID.make(first.activationID.replace(/^ska_/, "evt_")) },
            ] as const,
            ...rest.map(
              (activation) =>
                [
                  SessionEvent.Skill.Activated,
                  activation,
                  { id: Event.ID.make(activation.activationID.replace(/^ska_/, "evt_")) },
                ] as const,
            ),
            [
              SessionEvent.InboxEnqueued,
              { inboxID: request.id, sessionID: request.sessionID, item: request.item },
              { expectedSequence: request.expectedSequence },
            ] as const,
          ])
          .pipe(Effect.map((events) => events[events.length - 1]))
      : bus.publish(
          SessionEvent.InboxEnqueued,
          {
            inboxID: request.id,
            sessionID: request.sessionID,
            item: request.item,
          },
          { expectedSequence: request.expectedSequence },
        ))
      .pipe(
        Effect.map((event) =>
          Info.make({
            id: request.id,
            sessionID: request.sessionID,
            time: { created: DateTime.makeUnsafe(event.created) },
            ...request.item,
          }),
        ),
        Effect.catchDefect((defect) =>
          defect instanceof LifecycleConflict
            ? find(db, request.id).pipe(
                Effect.flatMap((stored) => (stored === undefined ? Effect.fail(defect) : Effect.succeed(stored))),
              )
            : Effect.die(defect),
        ),
      )
    if (!matches(admitted, { ...request, type: request.item.type }))
      return yield* new LifecycleConflict({ id: request.id })
    return admitted
  })

  const idleBoundary = Effect.fn("SessionInbox.idleBoundary")(function* (sessionID: SessionSchema.ID) {
    const captured = yield* db
      .transaction(
        () =>
          Effect.gen(function* () {
            if (yield* has(db, sessionID, "input")) return undefined
            return {
              expectedSequence: yield* Bus.latestSequence(db, sessionID),
              prepared: yield* hasPreparedChild(db, sessionID),
            }
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.orDie)
    if (captured === undefined) return undefined
    return {
      admit: (input): Effect.Effect<IdleAdmission> =>
        serialized(
          sessionID,
          Effect.gen(function* () {
            const request = {
              id: input.id,
              sessionID,
              type: "synthetic" as const,
              delivery: "steer" as const,
            }
            if (yield* reconcile(request)) return "duplicate"
            // An authorized child admission that has not started yet will wake this parent later.
            if (captured.prepared) return "stale"
            return yield* admit({
              id: input.id,
              sessionID,
              expectedSequence: captured.expectedSequence,
              item: {
                type: "synthetic",
                payload: SyntheticPayload.make({ text: input.text, description: input.description }),
                delivery: "steer",
              },
            }).pipe(
              Effect.orDie,
              Effect.as<IdleAdmission>("admitted"),
              Effect.catchDefect((defect) => {
                if (!(defect instanceof Bus.StaleAggregateError)) return Effect.die(defect)
                return reconcile(request).pipe(
                  Effect.map((existing): IdleAdmission => (existing ? "duplicate" : "stale")),
                )
              }),
            )
          }),
        ).pipe(Effect.orDie),
    } satisfies IdleBoundary
  })

  /** Records an authorized child admission on its parent. Wakes nothing; replay with the same binding is a no-op. */
  const prepareChild = Effect.fn("SessionInbox.prepareChild")(function* (input: {
    readonly sessionID: SessionSchema.ID
    readonly admissionID: string
    readonly childSessionID: SessionSchema.ID
  }) {
    return yield* serialized(
      input.sessionID,
      Effect.gen(function* () {
        const existing = yield* preparation(db, input.admissionID)
        if (existing) {
          if (existing.session_id === input.sessionID && existing.child_session_id === input.childSessionID) return
          return yield* new ChildPreparationConflictError({ admissionID: input.admissionID })
        }
        yield* bus.publish(SessionEvent.ChildPrepared, input)
      }),
    )
  })

  /** Resolves a prepared child admission. Unknown or already resolved admissions are a no-op. */
  const resolveChild = Effect.fn("SessionInbox.resolveChild")(function* (input: {
    readonly sessionID: SessionSchema.ID
    readonly admissionID: string
    readonly outcome: "started" | "cancelled"
  }) {
    return yield* serialized(
      input.sessionID,
      Effect.gen(function* () {
        const existing = yield* preparation(db, input.admissionID)
        if (existing?.session_id !== input.sessionID || existing.status !== "prepared") return
        yield* bus.publish(SessionEvent.ChildResolved, input)
      }),
    )
  })

  /**
   * Admits a continuation only while `boundaryID` is still the Session's newest message, an idle entry whose outcome is
   * one of `outcomes` (default failed only), and no input is pending. A changed model commits in the same conditional
   * write, so a rejection leaves neither the model nor the continuation behind. Wakes nothing.
   */
  const admitAfter = Effect.fn("SessionInbox.admitAfter")(function* (input: {
    readonly sessionID: SessionSchema.ID
    readonly boundaryID: SessionMessage.ID
    readonly id: SessionMessage.ID
    readonly text: string
    readonly description?: string
    readonly model?: Model.Ref
    readonly outcomes?: ReadonlyArray<"succeeded" | "failed" | "interrupted">
    readonly authority?: Effect.Effect<boolean>
    readonly commit?: () => Effect.Effect<void>
    readonly admitted?: Effect.Effect<void>
  }) {
    const request = { id: input.id, sessionID: input.sessionID, type: "synthetic" as const, delivery: "steer" as const }
    return yield* serialized(
      input.sessionID,
      Effect.gen(function* () {
        if (yield* reconcile(request)) return "duplicate" as const
        const captured = yield* db
          .transaction(
            () =>
              Effect.gen(function* () {
                if (input.authority && !(yield* input.authority)) return undefined
                if (yield* has(db, input.sessionID, "input")) return undefined
                if (!(yield* continuationBoundary(db, input.sessionID, input.boundaryID, input.outcomes ?? ["failed"])))
                  return undefined
                const session = yield* db
                  .select({ model: SessionTable.model, revert: SessionTable.revert })
                  .from(SessionTable)
                  .where(eq(SessionTable.id, input.sessionID))
                  .get()
                  .pipe(Effect.orDie)
                if (input.outcomes?.includes("succeeded")) {
                  if (session?.revert || (yield* hasPreparedChild(db, input.sessionID))) return undefined
                }
                return {
                  expectedSequence: yield* Bus.latestSequence(db, input.sessionID),
                  // The same model shape Session.switchModel compares and records as `previous`.
                  previous: session?.model
                    ? Model.Ref.make({
                        id: Model.ID.make(session.model.id),
                        providerID: Provider.ID.make(session.model.providerID),
                        variant: Model.VariantID.make(session.model.variant ?? "default"),
                      })
                    : undefined,
                }
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
        if (captured === undefined) return "stale" as const
        const options = { expectedSequence: captured.expectedSequence }
        const enqueue = [
          SessionEvent.InboxEnqueued,
          {
            inboxID: input.id,
            sessionID: input.sessionID,
            item: {
              type: "synthetic",
              payload: SyntheticPayload.make({ text: input.text, description: input.description }),
              delivery: "steer",
            },
          },
          { ...options, commit: input.commit },
        ] as const
        const publish: Effect.Effect<void> =
          input.model && !sameModel(input.model, captured.previous)
            ? bus.publishAll([
                  [
                    SessionEvent.ModelSelected,
                    { sessionID: input.sessionID, model: input.model, previous: captured.previous },
                    options,
                  ] as const,
                  enqueue,
                ])
                .pipe(Effect.asVoid)
            : bus.publishAll([enqueue]).pipe(Effect.asVoid)
        return yield* publish.pipe(
          Effect.andThen(input.admitted ?? Effect.void),
          Effect.as("admitted" as const),
          Effect.catchDefect((defect) => {
            if (!(defect instanceof Bus.StaleAggregateError)) return Effect.die(defect)
            return reconcile(request).pipe(Effect.map((existing) => (existing ? ("duplicate" as const) : ("stale" as const))))
          }),
        )
      }),
    ).pipe(Effect.orDie)
  })

  const admitCompaction = Effect.fn("SessionInbox.admitCompaction")(function* (input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly delivery: Delivery
  }) {
    return yield* serialized(
      input.sessionID,
      Effect.gen(function* () {
        const exact = yield* find(db, input.id)
        if (exact) {
          if (exact.type === "compaction" && exact.sessionID === input.sessionID) return exact
          return yield* new LifecycleConflict({ id: input.id })
        }
        if (yield* promotedFromMessage(db, input.sessionID, input.id, input.delivery))
          return yield* new LifecycleConflict({ id: input.id })
        const pending = (yield* list(db, input.sessionID)).find((item) => item.type === "compaction")
        if (pending) return pending
        return yield* admit({
          id: input.id,
          sessionID: input.sessionID,
          item: { type: "compaction", payload: {}, delivery: input.delivery },
        })
      }),
    )
  })

  const cancel = Effect.fn("SessionInbox.cancel")((input: PendingRef) =>
    publishMutation(
      input,
      bus.publish(SessionEvent.InboxCancelled, {
        sessionID: input.sessionID,
        inboxID: input.id,
      }),
    ),
  )

  const steer = Effect.fn("SessionInbox.steer")((input: PendingRef) =>
    publishMutation(
      input,
      bus.publish(SessionEvent.InboxDeliveryChanged, {
        sessionID: input.sessionID,
        inboxID: input.id,
        delivery: "steer",
      }),
    ),
  )

  const queue = Effect.fn("SessionInbox.queue")((input: PendingRef) =>
    publishMutation(
      input,
      bus.publish(SessionEvent.InboxDeliveryChanged, {
        sessionID: input.sessionID,
        inboxID: input.id,
        delivery: "queue",
      }),
    ),
  )

  return {
    list: (sessionID: SessionSchema.ID) => list(db, sessionID),
    reconcile,
    admit,
    admitCompaction,
    idleBoundary,
    prepareChild,
    resolveChild,
    admitAfter,
    cancel,
    steer,
    queue,
  }
})

export const layer = Layer.effect(Service, make())

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Bus.node] })

export const projectAdmitted = Effect.fn("SessionInbox.projectAdmitted")(function* (
  db: DatabaseService,
  request: {
    readonly enqueuedSeq: number
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly item: Item
    readonly timeCreated: number
  },
) {
  const message = yield* db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, request.id))
    .get()
    .pipe(Effect.orDie)
  if (message !== undefined) return yield* Effect.die(new LifecycleConflict({ id: request.id }))
  const payload =
    request.item.type === "user"
      ? encodeStoredUser(yield* SessionBlob.externalizePayload(db, request.item.payload))
      : request.item.type === "synthetic"
        ? encodeSynthetic(request.item.payload)
        : request.item.type === "compaction"
          ? encodeCompaction(request.item.payload)
          : encodeMove(request.item.payload)
  const stored = yield* db
    .insert(SessionInboxTable)
    .values({
      id: request.id,
      session_id: request.sessionID,
      type: request.item.type,
      payload,
      delivery: request.item.delivery,
      enqueued_seq: request.enqueuedSeq,
      time_created: request.timeCreated,
    })
    .onConflictDoNothing()
    .returning({ id: SessionInboxTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!stored) return yield* Effect.die(new LifecycleConflict({ id: request.id }))
  yield* SessionBlob.recordRefs(
    db,
    { sessionID: request.sessionID, messageID: request.id, seq: request.enqueuedSeq },
    payload,
  )
})

/**
 * Consume one pending row at promotion. The row's content feeds the projected
 * message insert inside the same event transaction; the deleted row is what
 * makes the table pending-only.
 */
export const projectDelivered = Effect.fn("SessionInbox.projectDelivered")(function* (
  db: DatabaseService,
  input: PendingRef,
) {
  const deleted = yield* db
    .delete(SessionInboxTable)
    .where(and(eq(SessionInboxTable.id, input.id), eq(SessionInboxTable.session_id, input.sessionID)))
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (!deleted) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  return delivered(deleted)
})

/** A consumed row with its payload as stored, so user file refs reach the message without their blobs. */
export type Delivered =
  | { readonly id: SessionMessage.ID; readonly type: "user"; readonly payload: SessionStored.UserPayload }
  | { readonly id: SessionMessage.ID; readonly type: "synthetic"; readonly payload: SyntheticPayload }
  | { readonly id: SessionMessage.ID; readonly type: "compaction" | "move" }

const delivered = (row: typeof SessionInboxTable.$inferSelect): Delivered => {
  if (row.type === "user") return { id: row.id, type: "user", payload: decodeStoredUser(row.payload) }
  if (row.type === "synthetic") return { id: row.id, type: "synthetic", payload: decodeSynthetic(row.payload) }
  return { id: row.id, type: row.type }
}

export const projectCancelled = Effect.fn("SessionInbox.projectCancelled")(function* (
  db: DatabaseService,
  input: PendingRef,
) {
  const deleted = yield* db
    .delete(SessionInboxTable)
    .where(
      and(
        eq(SessionInboxTable.id, input.id),
        eq(SessionInboxTable.session_id, input.sessionID),
        or(eq(SessionInboxTable.delivery, "queue"), eq(SessionInboxTable.delivery, "steer")),
      ),
    )
    .returning({ id: SessionInboxTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!deleted) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  yield* SessionBlob.releaseMessage(db, input.sessionID, input.id)
})

const projectDelivery = Effect.fn("SessionInbox.projectDelivery")(function* (
  db: DatabaseService,
  input: PendingRef & { readonly from: Delivery; readonly to: Delivery },
) {
  const updated = yield* db
    .update(SessionInboxTable)
    .set({ delivery: input.to })
    .where(
      and(
        eq(SessionInboxTable.id, input.id),
        eq(SessionInboxTable.session_id, input.sessionID),
        eq(SessionInboxTable.delivery, input.from),
      ),
    )
    .returning({ id: SessionInboxTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!updated) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
})

export const projectDeliveryChanged = Effect.fn("SessionInbox.projectDeliveryChanged")(
  (db: DatabaseService, input: PendingRef & { readonly delivery: Delivery }) =>
    projectDelivery(db, {
      ...input,
      from: input.delivery === "steer" ? "queue" : "steer",
      to: input.delivery,
    }),
)

const listRows = (db: DatabaseService, sessionID: SessionSchema.ID) =>
  db
    .select()
    .from(SessionInboxTable)
    .where(eq(SessionInboxTable.session_id, sessionID))
    .orderBy(asc(SessionInboxTable.enqueued_seq))
    .all()
    .pipe(Effect.orDie)

export const list = Effect.fn("SessionInbox.list")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return (yield* SessionBlob.hydrateInbox(db, yield* listRows(db, sessionID))).map(fromRow)
})

/** {@link list} for clients that fetch media themselves: files stored in `blob` stay `media:` refs. */
export const listWithRefs = Effect.fn("SessionInbox.listWithRefs")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const kept = yield* SessionBlob.keepInboxRefs(db, yield* listRows(db, sessionID))
  return kept.rows.map((row): MediaInfo => {
    if (row.type !== "user") return fromRow(row)
    const payload = decodeMediaUser(row.payload)
    return MediaUser.make({
      id: row.id,
      sessionID: row.session_id,
      time: { created: DateTime.makeUnsafe(row.time_created) },
      type: "user",
      payload: payload.files ? { ...payload, files: SessionBlob.describe(payload.files, kept.meta) } : payload,
      delivery: row.delivery,
    })
  })
})

export const moveIDs = Effect.fn("SessionInbox.moveIDs")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* db
    .select({ id: SessionInboxTable.id })
    .from(SessionInboxTable)
    .where(and(eq(SessionInboxTable.session_id, sessionID), eq(SessionInboxTable.type, "move")))
    .orderBy(asc(SessionInboxTable.enqueued_seq))
    .all()
    .pipe(Effect.orDie)
})

export const nextPromotable = Effect.fn("SessionInbox.nextPromotable")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  promotable: Promotable,
) {
  const steer = (yield* pendingSteers(db, sessionID))[0]
  if (steer) return promotion(steer)
  if (promotable !== "input") return undefined
  const queued = yield* firstQueued(db, sessionID)
  return queued ? promotion(queued) : undefined
})

/** What a boundary decides on: prompts are promoted by id, so only a move's payload is read. */
export type Promotion =
  | { readonly id: SessionMessage.ID; readonly type: "user" | "synthetic" | "compaction"; readonly delivery: Delivery }
  | {
      readonly id: SessionMessage.ID
      readonly type: "move"
      readonly delivery: Delivery
      readonly payload: MovePayload
    }

const promotion = (row: typeof SessionInboxTable.$inferSelect): Promotion =>
  row.type === "move"
    ? { id: row.id, type: "move", delivery: row.delivery, payload: decodeMove(row.payload) }
    : { id: row.id, type: row.type, delivery: row.delivery }

/** Which pending rows count: "input" means any item in either delivery mode. */
export type Scope = "input" | Delivery

export const has = Effect.fn("SessionInbox.has")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  scope: Scope,
) {
  const row = yield* db
    .select({ id: SessionInboxTable.id })
    .from(SessionInboxTable)
    .where(
      and(
        eq(SessionInboxTable.session_id, sessionID),
        scope === "input"
          ? or(eq(SessionInboxTable.delivery, "steer"), eq(SessionInboxTable.delivery, "queue"))
          : eq(SessionInboxTable.delivery, scope),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row !== undefined
})

const preparation = (db: DatabaseService, admissionID: string) =>
  db
    .select()
    .from(SessionChildPreparationTable)
    .where(eq(SessionChildPreparationTable.admission_id, admissionID))
    .get()
    .pipe(Effect.orDie)

/** True while `boundaryID` is the Session's newest message and an idle entry with one of the accepted outcomes. */
const continuationBoundary = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  boundaryID: SessionMessage.ID,
  outcomes: ReadonlyArray<"succeeded" | "failed" | "interrupted">,
) {
  const row = yield* db
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, sessionID))
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (row?.id !== boundaryID || row.type !== "idle") return false
  const [message] = yield* SessionHistory.decodeMessageRows(db, [row]).pipe(Effect.orDie)
  return message?.type === "idle" && outcomes.some((outcome) => outcome === message.outcome)
})

const sameModel = (model: Model.Ref, current: Model.Ref | undefined) =>
  current?.providerID === model.providerID &&
  current.id === model.id &&
  (current.variant ?? "default") === (model.variant ?? "default")

const hasPreparedChild = (db: DatabaseService, sessionID: SessionSchema.ID) =>
  db
    .select({ id: SessionChildPreparationTable.admission_id })
    .from(SessionChildPreparationTable)
    .where(
      and(
        eq(SessionChildPreparationTable.session_id, sessionID),
        eq(SessionChildPreparationTable.status, "prepared"),
      ),
    )
    .limit(1)
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row !== undefined),
    )

const publishMutation = <A, E, R>(input: PendingRef, effect: Effect.Effect<A, E, R>) =>
  serialized(input.sessionID, effect).pipe(
    Effect.asVoid,
    // Bus projectors abort their transaction through the defect channel.
    Effect.catchDefect((defect) => (defect instanceof LifecycleConflict ? Effect.fail(defect) : Effect.die(defect))),
  )

const publish = Effect.fn("SessionInbox.publish")(function* (
  db: DatabaseService,
  bus: Bus.Interface,
  sessionID: SessionSchema.ID,
  rows: ReadonlyArray<typeof SessionInboxTable.$inferSelect>,
) {
  yield* Effect.forEach(
    rows,
    (row) => {
      if (row.type !== "move" && row.type !== "user" && row.type !== "synthetic")
        return Effect.die(new LifecycleConflict({ id: row.id }))
      return bus
        .publish(SessionEvent.InboxDelivered, {
          sessionID,
          inboxID: row.id,
        })
        .pipe(
          Effect.catchDefect((defect) =>
            defect instanceof LifecycleConflict
              ? promotedFromMessage(db, sessionID, row.id, row.delivery).pipe(
                  Effect.flatMap((stored) => (stored !== undefined ? Effect.void : Effect.die(defect))),
                  Effect.orDie,
                )
              : Effect.die(defect),
          ),
        )
    },
    { discard: true },
  )
  return rows.length
})

/**
 * Promotes pending input into visible messages and returns the promoted count,
 * or undefined when the runner must first handle a pending control.
 * Steered compaction takes priority over pending prompts, without crossing a move.
 * Only the "input" scope may fall through to one queued input.
 */
export const promote = Effect.fn("SessionInbox.promote")(function* (
  db: DatabaseService,
  bus: Bus.Interface,
  sessionID: SessionSchema.ID,
  scope: Promotable,
) {
  return yield* serialized(
    sessionID,
    Effect.gen(function* () {
      const steers = yield* pendingSteers(db, sessionID)
      if (steers.length > 0 || scope === "steer") {
        if (steers.length > 0 && isControl(steers[0])) return undefined
        return yield* publish(db, bus, sessionID, beforeControl(steers))
      }

      const queued = yield* firstQueued(db, sessionID)
      if (!queued) return 0
      if (isControl(queued)) return undefined
      const promoted = yield* publish(db, bus, sessionID, [queued])
      return promoted + (yield* publish(db, bus, sessionID, beforeControl(yield* pendingSteers(db, sessionID))))
    }),
  )
})

const isControl = (row: typeof SessionInboxTable.$inferSelect) => row.type === "compaction" || row.type === "move"

const beforeControl = (rows: Array<typeof SessionInboxTable.$inferSelect>) => {
  const control = rows.findIndex(isControl)
  return control === -1 ? rows : rows.slice(0, control)
}

const firstQueued = (db: DatabaseService, sessionID: SessionSchema.ID) =>
  db
    .select()
    .from(SessionInboxTable)
    .where(and(eq(SessionInboxTable.session_id, sessionID), eq(SessionInboxTable.delivery, "queue")))
    .orderBy(asc(SessionInboxTable.enqueued_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)

const pendingSteers = (db: DatabaseService, sessionID: SessionSchema.ID) =>
  db
    .select()
    .from(SessionInboxTable)
    .where(and(eq(SessionInboxTable.session_id, sessionID), eq(SessionInboxTable.delivery, "steer")))
    .orderBy(asc(SessionInboxTable.enqueued_seq))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => {
        // A move changes the context's Location: never pull compaction across it.
        // Within that boundary, compact before promoting even earlier steers so
        // their text stays verbatim after the checkpoint, not inside its summary.
        const control = rows.findIndex(isControl)
        if (control > 0 && rows[control].type === "compaction") rows.unshift(...rows.splice(control, 1))
        return rows
      }),
    )
