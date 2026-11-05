import { describe, expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { SessionInterruptJournal } from "@opencode/core/session/interrupt-journal"
import { KV } from "@opencode/core/kv"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer } from "effect"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"

// Records wakes per Session; each test only reads its own Session's entries.
const woken: string[] = []
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node, KV.node]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(
        Layer.succeed(
          SessionExecution.Service,
          SessionExecution.Service.of({
            ...SessionExecution.noop,
            active: Effect.succeed(new Set()),
            isActive: () => Effect.succeed(false),
            resume: () => Effect.void,
            wake: (sessionID) => Effect.sync(() => void woken.push(sessionID)),
            interrupt: () => Effect.succeed(false),
            awaitIdle: () => Effect.void,
          }),
        ),
      ),
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const primary = Model.Ref.make({ id: Model.ID.make("primary"), providerID: Provider.ID.make("test") })
const fallback = Model.Ref.make({ id: Model.ID.make("fallback"), providerID: Provider.ID.make("test") })

const failedSession = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const bus = yield* Bus.Service
  const created = yield* sessions.create({ location, model: primary })
  yield* bus.publish(SessionEvent.Execution.Failed, { sessionID: created.id, error: { type: "unknown", message: "failed" } })
  const boundary = (yield* sessions.messages({ sessionID: created.id, order: "asc" })).at(-1)
  if (boundary?.type !== "idle" || boundary.outcome !== "failed") return yield* Effect.die(new Error("Expected a failed idle boundary"))
  const request = { sessionID: created.id, boundaryID: boundary.id, id: SessionMessage.ID.create(), text: "Continue", model: fallback }
  return { sessions, bus, sessionID: created.id, request }
})
const wakes = (sessionID: string) => woken.filter((item) => item === sessionID).length

describe("Session.continueAfterFailure", () => {
  it.effect("admits the model change and continuation once and wakes once", () =>
    Effect.gen(function* () {
      const { sessions, sessionID, request } = yield* failedSession

      expect(yield* sessions.continueAfterFailure(request)).toBe("admitted")
      expect(yield* sessions.continueAfterFailure(request)).toBe("duplicate")

      expect((yield* sessions.get(sessionID)).model).toMatchObject({ id: fallback.id, providerID: fallback.providerID })
      expect((yield* sessions.inbox(sessionID)).map((item) => [item.id, item.type])).toEqual([[request.id, "synthetic"]])
      expect(wakes(sessionID)).toBe(1)
    }),
  )

  it.effect("writes and wakes nothing when new input moved the boundary", () =>
    Effect.gen(function* () {
      const { sessions, sessionID, request } = yield* failedSession
      const input = yield* sessions.synthetic({ sessionID, text: "user steer", resume: false })

      expect(yield* sessions.continueAfterFailure(request)).toBe("stale")

      expect((yield* sessions.get(sessionID)).model).toMatchObject({ id: primary.id })
      expect((yield* sessions.inbox(sessionID)).map((item) => item.id)).toEqual([input.id])
      expect(wakes(sessionID)).toBe(0)
    }),
  )

  it.effect("writes and wakes nothing after an interrupt", () =>
    Effect.gen(function* () {
      const { sessions, bus, sessionID, request } = yield* failedSession
      yield* bus.publish(SessionEvent.Execution.Interrupted, { sessionID, reason: "user" })

      expect(yield* sessions.continueAfterFailure(request)).toBe("stale")

      expect((yield* sessions.get(sessionID)).model).toMatchObject({ id: primary.id })
      expect(yield* sessions.inbox(sessionID)).toEqual([])
      expect(wakes(sessionID)).toBe(0)
    }),
  )

  it.effect("resumes an interrupted boundary only when the caller allows its own interrupt", () =>
    Effect.gen(function* () {
      const { sessions, bus, sessionID, request } = yield* failedSession
      yield* bus.publish(SessionEvent.Execution.Interrupted, { sessionID, reason: "user" })
      const boundary = (yield* sessions.messages({ sessionID, order: "desc", limit: 1 }))[0]
      if (boundary?.type !== "idle" || boundary.outcome !== "interrupted") return yield* Effect.die(new Error("Expected an interrupted idle"))
      const interrupted = { ...request, boundaryID: boundary.id }

      // A user interrupt is never journaled, so PluginHost passes the default failed-only rule.
      expect(yield* sessions.continueAfterFailure(interrupted)).toBe("stale")
      expect(yield* sessions.inbox(sessionID)).toEqual([])
      expect(wakes(sessionID)).toBe(0)

      const own = { ...interrupted, outcomes: ["failed", "interrupted"] as const }
      expect(yield* sessions.continueAfterFailure(own)).toBe("admitted")
      expect(yield* sessions.continueAfterFailure(own)).toBe("duplicate")
      expect((yield* sessions.get(sessionID)).model).toMatchObject({ id: fallback.id })
      expect(wakes(sessionID)).toBe(1)
    }),
  )

  it.effect("retains abandoned recovery ownership separately from durably admitted successors", () =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const journal = yield* SessionInterruptJournal.make(kv)
      const owner = { pluginID: "owner", lifetime: "before-restart" }
      const held = yield* journal.begin(Session.ID.make("ses_held"), owner, "held-generation")
      const admitted = yield* journal.begin(Session.ID.make("ses_admitted"), owner, "admitted-generation")
      if (!held || !admitted) throw new Error("Recovery attempts were not recorded")
      yield* journal.commit(admitted)
      const restarted = yield* SessionInterruptJournal.make(kv)
      expect(restarted.abandoned().map((attempt) => attempt.record.sessionID)).toEqual(["ses_held"])
      const [abandoned] = restarted.abandoned()
      if (!abandoned) throw new Error("Abandoned attempt was not restored")
      yield* restarted.finish(abandoned, "failed", "Recovery abandoned by host restart")
      expect((yield* SessionInterruptJournal.make(kv)).abandoned()).toEqual([])
      expect(restarted.get("ses_admitted")?.record).toMatchObject({ phase: "committed", generation: "admitted-generation" })
    }),
  )
})
