import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { SessionMessage } from "@opencode/core/session/message"
import { admissionFixture, admissionTests } from "./fixture/subagent-admission"

const it = admissionTests
const owner = { pluginID: "resume-owner", lifetime: "resume" }

// A plugin interrupts a running turn to recover it. Whatever the plugin then does, the interrupted turn of an
// interactive Session must be continued, unless the user stopped it or sent newer input.
const stalledTurn = Effect.gen(function* () {
  const { sessions, parent, llm } = yield* admissionFixture
  const primary = yield* llm.gate()
  yield* Effect.addFinalizer(() => primary.release)
  yield* sessions.prompt({ sessionID: parent.id, text: "work" })
  yield* primary.started.pipe(Effect.timeout("2 seconds"))
  const resumed = yield* llm.gate()
  yield* Effect.addFinalizer(() => resumed.release)
  const outcomes = Effect.gen(function* () {
    const idles = (yield* sessions.messages({ sessionID: parent.id, order: "asc", type: "idle" })).flatMap((m) => (m.type === "idle" ? [m.outcome] : []))
    const synthetic = (yield* sessions.context(parent.id)).filter((m) => m.type === "synthetic")
    return { idles, synthetic: synthetic.length }
  })
  return { sessions, parent, resumed, outcomes }
})

describe("Session.recover for an interactive Session", () => {
  it.live("continues the turn when the plugin declines after its interrupt", () =>
    Effect.gen(function* () {
      const { sessions, parent, resumed, outcomes } = yield* stalledTurn

      const recovered = yield* sessions.recover({ sessionID: parent.id, owner }, () => Effect.succeed(false))

      expect(recovered).toBe(true)
      yield* resumed.started.pipe(Effect.timeout("2 seconds"))
      yield* resumed.release
      yield* sessions.wait(parent.id).pipe(Effect.timeout("2 seconds"))
      expect(yield* outcomes).toEqual({ idles: ["interrupted", "succeeded"], synthetic: 1 })
    }),
  )

  it.live("continues the turn and reports the failure when the plugin callback throws", () =>
    Effect.gen(function* () {
      const { sessions, parent, resumed, outcomes } = yield* stalledTurn

      const exit = yield* sessions.recover({ sessionID: parent.id, owner }, () => Effect.fail(new Error("callback failed"))).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      yield* resumed.started.pipe(Effect.timeout("2 seconds"))
      yield* resumed.release
      yield* sessions.wait(parent.id).pipe(Effect.timeout("2 seconds"))
      expect((yield* outcomes).idles).toEqual(["interrupted", "succeeded"])
    }),
  )

  it.live("continues the turn when the plugin is disposed mid-recovery", () =>
    Effect.gen(function* () {
      const { sessions, parent, resumed, outcomes } = yield* stalledTurn

      yield* sessions.recover({ sessionID: parent.id, owner }, () => sessions.closeRecovery(owner).pipe(Effect.as(false)))

      yield* resumed.started.pipe(Effect.timeout("2 seconds"))
      yield* resumed.release
      yield* sessions.wait(parent.id).pipe(Effect.timeout("2 seconds"))
      expect((yield* outcomes).idles).toEqual(["interrupted", "succeeded"])
    }),
  )

  it.live("does not continue a turn the user stopped during recovery", () =>
    Effect.gen(function* () {
      const { sessions, parent, outcomes } = yield* stalledTurn

      const recovered = yield* sessions.recover({ sessionID: parent.id, owner }, () => sessions.interrupt(parent.id).pipe(Effect.as(false)))

      const result = yield* outcomes
      expect(recovered).toBe(false)
      expect(result.idles.every((outcome) => outcome === "interrupted")).toBe(true)
      expect(result.synthetic).toBe(0)
    }),
  )

  it.live("does not continue over newer input", () =>
    Effect.gen(function* () {
      const { sessions, parent, outcomes } = yield* stalledTurn

      yield* sessions.recover({ sessionID: parent.id, owner }, () =>
        sessions.synthetic({ sessionID: parent.id, id: SessionMessage.ID.create(), text: "newer input", resume: false }).pipe(Effect.as(false)),
      )

      const result = yield* outcomes
      expect(result.idles).toEqual(["interrupted", "failed"])
    }),
  )
})
