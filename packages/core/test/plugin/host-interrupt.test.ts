import { describe, expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { Location } from "@opencode/core/location"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { makePluginTestLayer } from "./fixture"

// The execution seam: `interrupt` settles the interrupted execution, and `awaitIdle` runs whatever the test
// schedules between that settlement and the plugin's journal read. Each test sets both before acting.
const seam = {
  interrupt: (_sessionID: Session.ID): Effect.Effect<boolean> => Effect.succeed(false),
  awaitIdle: (_sessionID: Session.ID): Effect.Effect<void> => Effect.void,
  woken: [] as string[],
}
const it = testEffect(
  makePluginTestLayer(
    undefined,
    undefined,
    undefined,
    Layer.succeed(
      SessionExecution.Service,
      SessionExecution.Service.of({
        ...SessionExecution.noop,
        active: Effect.succeed(new Set()),
        isActive: () => Effect.succeed(false),
        resume: () => Effect.void,
        wake: (sessionID) => Effect.sync(() => void seam.woken.push(sessionID)),
        interrupt: (sessionID) => seam.interrupt(sessionID),
        awaitIdle: (sessionID) => seam.awaitIdle(sessionID),
      }),
    ),
  ),
)
const fallback = Model.Ref.make({ id: Model.ID.make("fallback"), providerID: Provider.ID.make("test") })

const setup = Effect.gen(function* () {
  const plugins = yield* Plugin.Service
  const sessions = yield* Session.Service
  const bus = yield* Bus.Service
  const location = yield* Location.Service
  const host = yield* PluginHost.make(plugins, "watchdog")
  const session = yield* sessions.create({ location: { directory: location.directory } })
  // The coordinator publishes this terminal when the interrupted execution settles.
  seam.interrupt = (sessionID) =>
    bus.publish(SessionEvent.Execution.Interrupted, { sessionID, reason: "user" }).pipe(Effect.as(true))
  seam.awaitIdle = () => Effect.void
  const wakes = () => seam.woken.filter((item) => item === session.id).length
  const continuation = (boundaryID: SessionMessage.ID) => ({
    sessionID: session.id,
    boundaryID,
    id: SessionMessage.ID.create(),
    text: "Continue",
    model: fallback,
  })
  return { host, sessions, bus, sessionID: session.id, wakes, continuation }
})

describe("PluginHost experimental.session.interrupt", () => {
  it.effect("does not authorize recovery from an ordinary plugin interrupt", () =>
    Effect.gen(function* () {
      const { host, sessions, sessionID, wakes, continuation } = yield* setup

      const result = yield* host.experimental.session.interrupt({ sessionID })
      const [newest] = yield* sessions.messages({ sessionID, order: "desc", limit: 1 })
      expect(newest).toMatchObject({ type: "idle", outcome: "interrupted" })
      expect(result).toEqual({ interrupted: true, boundaryID: newest?.id })
      if (result.boundaryID === undefined) return

      const request = continuation(result.boundaryID)
      expect(yield* host.experimental.session.continueAfterFailure(request)).toBe("stale")
      expect(wakes()).toBe(0)
      expect((yield* sessions.get(sessionID)).model?.id).not.toBe(fallback.id)
    }),
  )

  it.effect("never journals a user interrupt that lands before the journal read", () =>
    Effect.gen(function* () {
      const { host, sessions, bus, sessionID, wakes, continuation } = yield* setup
      // A user execution starts and is interrupted by the user after the plugin's execution settled.
      seam.awaitIdle = (id) =>
        bus.publish(SessionEvent.Execution.Started, { sessionID: id }).pipe(
          Effect.andThen(bus.publish(SessionEvent.Execution.Interrupted, { sessionID: id, reason: "user" })),
          Effect.asVoid,
        )

      const result = yield* host.experimental.session.interrupt({ sessionID })
      const idles = yield* sessions.messages({ sessionID, order: "asc", type: "idle" })
      expect(idles.map((item) => item.type === "idle" && item.outcome)).toEqual(["interrupted", "interrupted"])
      const [own, user] = idles
      expect(result).toEqual({ interrupted: true, boundaryID: own?.id })
      if (own === undefined || user === undefined) return

      // The user's idle is newest but not journaled; the plugin's own boundary is no longer newest.
      expect(yield* host.experimental.session.continueAfterFailure(continuation(user.id))).toBe("stale")
      expect(yield* host.experimental.session.continueAfterFailure(continuation(own.id))).toBe("stale")
      expect(yield* sessions.inbox(sessionID)).toEqual([])
      expect(wakes()).toBe(0)
      expect((yield* sessions.get(sessionID)).model?.id).not.toBe(fallback.id)
    }),
  )
})
