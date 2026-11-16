import { describe, expect, spyOn } from "bun:test"
import { Deferred, Effect, Fiber, Schema } from "effect"
import { Agent } from "@opencode/core/agent"
import { Job } from "@opencode/core/job"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionExecution } from "@opencode/core/session/execution"
import { SubagentSteerBinding } from "@opencode/core/session/subagent-steer-binding"
import { SubagentAdmissionRun } from "@opencode/core/session/subagent-admission-run"
import { SubagentAdmissionStore } from "@opencode/core/session/subagent-admission-store"
import { Permission } from "@opencode/core/permission"
import { admissionTests, runningAdmission } from "./fixture/subagent-admission"

describe("join-only subagent steer", () => {
  for (const spoof of ["agent", "message", "tool", "parent", "plugin", "generation", "original", "child"] as const) {
    admissionTests.live(`rejects a spoofed ${spoof} without enqueueing`, () => Effect.gen(function* () {
      const { host, steer, sessions, parent, input, bus } = yield* runningAdmission
      const other = yield* sessions.create({ location: parent.location, agent: input.invocation.agent, model: input.model })
      const foreignMessage = SessionMessage.ID.create()
      yield* bus.publish(SessionEvent.Step.Started, { sessionID: other.id, assistantMessageID: foreignMessage, agent: input.invocation.agent, model: input.model, started: 0 })
      yield* bus.publish(SessionEvent.Tool.Input.Started, { sessionID: other.id, assistantMessageID: foreignMessage, id: "foreign-call", name: "task" })
      const invocation = {
        ...steer.invocation,
        agent: spoof === "agent" ? Agent.ID.make("spoof") : steer.invocation.agent,
        messageID: spoof === "message" ? SessionMessage.ID.create() : spoof === "parent" ? foreignMessage : steer.invocation.messageID,
        toolCallID: spoof === "tool" ? "missing" : spoof === "parent" ? "foreign-call" : spoof === "original" ? input.invocation.toolCallID : steer.invocation.toolCallID,
      }
      const locations = yield* LocationServiceMap.Service
      const runs = yield* SubagentAdmissionRun.Service.pipe(Effect.provide(locations.get(parent.location)))
      const request = { ...steer, invocation, run: { ...steer.run, generation: spoof === "generation" ? "wrong" : steer.run.generation } }
      if (spoof === "child") yield* sessions.switchAgent({ sessionID: steer.run.childSessionID, agent: Agent.ID.make("build") })
      const result = yield* (spoof === "plugin" ? runs.steer("foreign", request) : host.experimental.subagent.steer(request)).pipe(Effect.result)
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "SubagentAdmission.Conflict" } })
      expect(yield* sessions.inbox(steer.run.childSessionID)).toEqual([])
    }))
  }

  admissionTests.live("uses the original permission action with the fresh tool source and denies explicit revocation", () => Effect.gen(function* () {
    const { host, steer, sessions, parent, bus } = yield* runningAdmission
    yield* sessions.setPermissions({ sessionID: parent.id, permissions: [{ action: "subagent", resource: "reviewer", effect: "ask" }] })
    const asked = yield* Deferred.make<Permission.Request>()
    yield* bus.listen((event) => event.type === Permission.Event.Asked.type
      ? Deferred.succeed(asked, Schema.decodeUnknownSync(Schema.toType(Permission.Request))(event.data)).pipe(Effect.asVoid)
      : Effect.void)
    const pending = yield* host.experimental.subagent.steer(steer).pipe(Effect.result, Effect.forkChild({ startImmediately: true }))
    const request = yield* Deferred.await(asked).pipe(Effect.timeout("2 seconds"))
    expect(request).toMatchObject({ sessionID: parent.id, action: "subagent", source: { type: "tool", messageID: steer.invocation.messageID, id: steer.invocation.toolCallID } })
    yield* sessions.setPermissions({ sessionID: parent.id, permissions: [{ action: "subagent", resource: "reviewer", effect: "deny" }] })
    yield* host.permission.reply({ requestID: request.id, reply: "once" })
    expect(yield* Fiber.join(pending)).toMatchObject({ _tag: "Failure", failure: { _tag: "Permission.BlockedError" } })
    expect(yield* sessions.inbox(steer.run.childSessionID)).toEqual([])
  }))

  for (const scenario of ["terminal", "replay"] as const) {
    admissionTests.live(`skips interactive permission and prompt hooks for ${scenario} while retaining explicit denial`, () => Effect.gen(function* () {
      const { host, steer, sessions, parent, bus, gate } = yield* runningAdmission
      const expected = scenario === "replay"
        ? yield* host.experimental.subagent.steer(steer)
        : { kind: "closed-before-admission" as const }
      if (scenario === "terminal") {
        yield* gate.release
        yield* host.experimental.subagent.wait({ run: steer.run }).pipe(Effect.timeout("2 seconds"))
      }
      yield* sessions.setPermissions({ sessionID: parent.id, permissions: [{ action: "subagent", resource: "reviewer", effect: "ask" }] })
      let approvals = 0
      let prompts = 0
      yield* bus.listen((event) => {
        if (event.type !== Permission.Event.Asked.type) return Effect.void
        approvals++
        const request = Schema.decodeUnknownSync(Schema.toType(Permission.Request))(event.data)
        return host.permission.reply({ requestID: request.id, reply: "once" }).pipe(Effect.orDie)
      })
      const locations = yield* LocationServiceMap.Service
      const hooks = yield* PluginHooks.Service.pipe(Effect.provide(locations.get(parent.location)))
      yield* hooks.register("session", "prompt", () => Effect.sync(() => { prompts++ }))
      const before = yield* sessions.inbox(steer.run.childSessionID)
      expect(yield* host.experimental.subagent.steer(steer).pipe(Effect.timeout("2 seconds"))).toEqual(expected)
      expect(approvals).toBe(0)
      expect(prompts).toBe(0)
      expect(yield* sessions.inbox(steer.run.childSessionID)).toEqual(before)
      yield* sessions.setPermissions({ sessionID: parent.id, permissions: [{ action: "subagent", resource: "reviewer", effect: "deny" }] })
      expect(yield* host.experimental.subagent.steer(steer).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { _tag: "Permission.BlockedError" } })
    }))
  }

  admissionTests.live("reconciles a lost response before and after delivery while retaining the original job and completion", () => Effect.gen(function* () {
    const { host, steer, sessions, parent, bus, gate, llm, started } = yield* runningAdmission
    const jobs = yield* Job.Service
    const original = yield* jobs.get(steer.run.childSessionID)
    const execution = yield* SessionExecution.Service
    const wake = spyOn(execution, "wake")
    yield* Effect.addFinalizer(() => Effect.sync(() => wake.mockRestore()))
    const completion = yield* Deferred.make<void>()
    yield* bus.listen((event) => event.type === SessionEvent.InboxEnqueued.type && event.durable?.aggregateID === parent.id
      ? Deferred.succeed(completion, undefined).pipe(Effect.asVoid) : Effect.void)
    const publish = bus.publish
    let lose = true
    const spy = spyOn(bus, "publish").mockImplementation((definition, data, options) => publish(definition, data, options).pipe(Effect.tap((event) => {
      if (!lose || event.type !== SessionEvent.InboxEnqueued.type || event.durable?.aggregateID !== steer.run.childSessionID) return Effect.void
      lose = false
      return Effect.die("lost admission response")
    })))
    yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()))
    expect((yield* host.experimental.subagent.steer(steer).pipe(Effect.exit))._tag).toBe("Failure")
    spy.mockRestore()
    const replay = yield* host.experimental.subagent.steer({ ...steer, prompt: { text: "ignored replay" }, metadata: { retry: true } })
    expect(replay).toMatchObject({ kind: "joined-existing-run", run: steer.run })
    expect(yield* host.experimental.subagent.steer(steer)).toEqual(replay)
    expect(wake.mock.calls.filter(([sessionID]) => sessionID === steer.run.childSessionID)).toHaveLength(1)
    const pending = yield* sessions.inbox(steer.run.childSessionID)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ type: "user", delivery: "steer", payload: { text: "clarification" } })
    expect(yield* jobs.get(steer.run.childSessionID)).toEqual(original)
    const next = yield* llm.gate()
    yield* gate.release
    yield* next.started.pipe(Effect.timeout("2 seconds"))
    expect(yield* llm.requests()).toHaveLength(2)
    expect(JSON.stringify(yield* llm.requests())).toContain("clarification")
    expect(JSON.stringify(yield* llm.requests())).not.toContain("ignored replay")
    yield* next.release
    expect((yield* host.experimental.subagent.wait({ run: steer.run }).pipe(Effect.timeout("2 seconds"))).receipt).toMatchObject({ status: "completed", run: steer.run, promptID: started.promptID })
    yield* Deferred.await(completion).pipe(Effect.timeout("2 seconds"))
    expect(yield* host.experimental.subagent.steer(steer)).toEqual(replay)
    expect((yield* sessions.inbox(parent.id)).filter((item) => item.type === "synthetic")).toHaveLength(1)
    const admissions = yield* SubagentAdmissionStore.Service
    expect((yield* admissions.list("lifetime-owner")).map((entry) => entry.admissionID)).toEqual(["original"])
  }))

  for (const conflict of ["session", "type"] as const) {
    admissionTests.live(`preserves deterministic prompt ${conflict} conflicts`, () => Effect.gen(function* () {
      const { host, steer, sessions, parent, input } = yield* runningAdmission
      const id = SubagentSteerBinding.promptID({ pluginID: "lifetime-owner", ...steer.invocation })
      const sessionID = conflict === "type" ? steer.run.childSessionID : (yield* sessions.create({ location: parent.location, agent: input.agent, model: input.model })).id
      yield* sessions.synthetic({ sessionID, id, text: "existing synthetic", resume: false })
      expect(yield* host.experimental.subagent.steer(steer).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { _tag: "SessionInbox.LifecycleConflict" } })
      expect((yield* sessions.inbox(steer.run.childSessionID)).filter((item) => item.type === "user")).toEqual([])
    }))
  }

  admissionTests.live("does not hold settlement serialization across hooks and enqueues nothing when settlement wins", () => Effect.gen(function* () {
    const { host, steer, sessions, parent, gate } = yield* runningAdmission
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
    const locations = yield* LocationServiceMap.Service
    const hooks = yield* PluginHooks.Service.pipe(Effect.provide(locations.get(parent.location)))
    yield* hooks.register("session", "prompt", () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
    const pending = yield* host.experimental.subagent.steer(steer).pipe(Effect.forkChild({ startImmediately: true }))
    yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))
    yield* gate.release
    expect((yield* host.experimental.subagent.wait({ run: steer.run }).pipe(Effect.timeout("2 seconds"))).receipt.status).toBe("completed")
    yield* Deferred.succeed(release, undefined)
    expect(yield* Fiber.join(pending).pipe(Effect.timeout("2 seconds"))).toEqual({ kind: "closed-before-admission" })
    expect(yield* sessions.inbox(steer.run.childSessionID)).toEqual([])
    expect((yield* sessions.context(steer.run.childSessionID)).filter((item) => item.type === "user").map((item) => item.text)).toEqual(["original work"])
  }))
})
