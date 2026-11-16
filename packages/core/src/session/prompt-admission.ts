export * as SessionPromptAdmission from "./prompt-admission.js"

import { Effect } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { Instance } from "../instance/service.js"
import { NotFoundError, PromptConflictError } from "./error.js"
import { SessionInbox } from "./inbox.js"
import { SessionMessage } from "./message.js"
import { SessionPrompt } from "./prompt.js"
import { SessionRevert } from "./revert.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"

export type Request = SessionPrompt.Input & {
  readonly id?: SessionMessage.ID
  readonly resume?: boolean
}

export type Prepared = {
  readonly existing: SessionInbox.User | undefined
  readonly publish: (policy?: {
    readonly delivery: SessionInbox.Delivery
    readonly metadata: Readonly<Record<string, unknown>>
  }) => Effect.Effect<SessionInbox.User, PromptConflictError>
}

export type WithPreparedPrompt = <A, E, R>(
  input: Request & { readonly sessionID: SessionSchema.ID },
  use: (prepared: Prepared) => Effect.Effect<A, E, R>,
) => Effect.Effect<A, unknown, R>

export const make = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const database = yield* Database.Service
  const store = yield* SessionStore.Service
  const instances = yield* Instance.Service
  const admission = yield* SessionInbox.Service
  const fs = yield* FSUtil.Service

  return <A, E, R>(
    input: Request & { readonly sessionID: SessionSchema.ID },
    use: (prepared: Prepared) => Effect.Effect<A, E, R>,
  ) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    const session = yield* store.get(input.sessionID)
    if (!session) return yield* new NotFoundError({ sessionID: input.sessionID })
    const messageID = input.id ?? SessionMessage.ID.create()
    const reconcile = admission.reconcile({ id: messageID, sessionID: session.id, type: "user", delivery: input.delivery ?? "steer" }).pipe(
      Effect.catchTag("SessionInbox.LifecycleConflict", () => new PromptConflictError({ sessionID: session.id, messageID })),
    )
    const existing = yield* reconcile
    if (existing) return yield* restore(use({ existing, publish: () => Effect.succeed(existing) }))
    // Keep one Location acquisition alive through hooks, staged revert and publication.
    return yield* Effect.gen(function* () {
      const prepared = yield* restore(SessionPrompt.prepare({ session, messageID, input, instances }))
      const publish: Prepared["publish"] = (policy) => Effect.gen(function* () {
        const existing = yield* reconcile
        if (existing) return existing
        if (session.revert) yield* SessionRevert.commit(bus, session)
        return yield* admission.admit({
          id: messageID,
          sessionID: session.id,
          item: policy === undefined ? prepared.item : {
            ...prepared.item,
            delivery: policy.delivery,
            payload: SessionInbox.UserPayload.make({ ...prepared.item.payload, metadata: { ...prepared.item.payload.metadata, ...policy.metadata } }),
          },
          activations: prepared.activations,
        }).pipe(Effect.catchTag("SessionInbox.LifecycleConflict", () => new PromptConflictError({ sessionID: session.id, messageID })))
      })
      return yield* restore(use({ existing: undefined, publish }))
    }).pipe(
      instances.provide(session),
      Effect.provideService(Database.Service, database),
      Effect.provideService(FSUtil.Service, fs),
      Effect.provideService(SessionStore.Service, store),
    )
  }))
})
