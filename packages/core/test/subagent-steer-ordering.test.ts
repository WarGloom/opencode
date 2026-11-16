import { describe, expect, spyOn } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { Bus } from "@opencode/core/bus"
import { Instance } from "@opencode/core/instance/service"
import { Job } from "@opencode/core/job"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { SessionEvent } from "@opencode/core/session/event"
import { admissionTests, runningAdmission } from "./fixture/subagent-admission"

describe("subagent steer publication ordering", () => {
  admissionTests.live("keeps one Location lifetime through preparation and publication and forces steer after hooks", () => Effect.gen(function* () {
    const { host, steer, sessions, parent, bus } = yield* runningAdmission
    const instances = yield* Instance.Service
    const original = instances.provide
    let acquired = 0
    let active: number | undefined
    const preparation: number[] = []
    const publication: number[] = []
    const provide: Instance.Interface["provide"] = (session) => (effect) => original(session)(Effect.acquireUseRelease(
      Effect.sync(() => { active = ++acquired }),
      () => effect,
      () => Effect.sync(() => { active = undefined }),
    ))
    const spy = spyOn(instances, "provide").mockImplementation(provide)
    yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()))
    const locations = yield* LocationServiceMap.Service
    const hooks = yield* PluginHooks.Service.pipe(Effect.provide(locations.get(parent.location)))
    yield* hooks.register("session", "prompt", (event) => Effect.sync(() => {
      if (active !== undefined) preparation.push(active)
      event.delivery = "queue"
      event.metadata = { transformed: true, opencodeSubagentSteer: "spoofed by hook" }
    }))
    yield* bus.project(SessionEvent.InboxEnqueued, (event) => Effect.sync(() => {
      if (event.data.sessionID === steer.run.childSessionID && active !== undefined) publication.push(active)
    }))
    expect(yield* host.experimental.subagent.steer(steer)).toMatchObject({ kind: "joined-existing-run", run: steer.run })
    expect(preparation).toEqual([1])
    expect(publication).toEqual([1])
    expect(active).toBeUndefined()
    expect(yield* sessions.inbox(steer.run.childSessionID)).toMatchObject([{
      delivery: "steer", payload: { metadata: { transformed: true, opencodeSubagentSteer: { pluginID: "lifetime-owner", admissionID: "original", generation: steer.run.generation } } },
    }])
    yield* sessions.prompt({ sessionID: steer.run.childSessionID, text: "ordinary prompt", resume: false })
    expect((yield* sessions.inbox(steer.run.childSessionID)).map((item) => item.delivery)).toEqual(["steer", "queue"])
  }))

  admissionTests.live("publishes, registers and wakes before the original Job can settle", () => Effect.gen(function* () {
    const { host, steer, sessions, parent, bus, gate, llm } = yield* runningAdmission
    const jobs = yield* Job.Service
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const settled = yield* Deferred.make<void>()
    const reported = yield* Deferred.make<void>()
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
    yield* bus.listen((event) => {
      if (event.type === SessionEvent.Execution.Succeeded.type && event.durable?.aggregateID === steer.run.childSessionID)
        return Deferred.succeed(settled, undefined).pipe(Effect.asVoid)
      if (event.type === SessionEvent.InboxEnqueued.type && event.durable?.aggregateID === parent.id)
        return Deferred.succeed(reported, undefined).pipe(Effect.asVoid)
      return Effect.void
    })
    const publish = bus.publish
    let hold = true
    const paused: Bus.Interface["publish"] = (definition, data, options) => {
      const wait = hold && definition.type === SessionEvent.InboxEnqueued.type
        ? Effect.sync(() => { hold = false }).pipe(Effect.andThen(Deferred.succeed(entered, undefined)), Effect.andThen(Deferred.await(release)))
        : Effect.void
      return wait.pipe(Effect.andThen(publish(definition, data, options)))
    }
    const spy = spyOn(bus, "publish").mockImplementation(paused)
    yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()))
    const joining = yield* host.experimental.subagent.steer(steer).pipe(Effect.forkChild({ startImmediately: true }))
    yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))
    const next = yield* llm.gate()
    yield* gate.release
    yield* Deferred.await(settled).pipe(Effect.timeout("2 seconds"))
    expect(yield* jobs.get(steer.run.childSessionID)).toMatchObject({ generation: steer.run.generation, status: "running" })
    yield* Deferred.succeed(release, undefined)
    expect(yield* Fiber.join(joining).pipe(Effect.timeout("2 seconds"))).toMatchObject({ kind: "joined-existing-run", run: steer.run })
    yield* next.started.pipe(Effect.timeout("2 seconds"))
    expect(yield* jobs.get(steer.run.childSessionID)).toMatchObject({ generation: steer.run.generation, status: "running" })
    yield* next.release
    expect((yield* host.experimental.subagent.wait({ run: steer.run }).pipe(Effect.timeout("2 seconds"))).receipt.status).toBe("completed")
    yield* Deferred.await(reported).pipe(Effect.timeout("2 seconds"))
    expect((yield* sessions.inbox(parent.id)).filter((item) => item.type === "synthetic")).toHaveLength(1)
    expect(yield* sessions.inbox(steer.run.childSessionID)).toEqual([])
  }))

  admissionTests.live("reports unread admission after publication fails before registration", () => Effect.gen(function* () {
    const { host, steer, sessions, parent, bus } = yield* runningAdmission
    const reported = yield* Deferred.make<void>()
    yield* bus.listen((event) => event.type === SessionEvent.InboxEnqueued.type && event.durable?.aggregateID === parent.id
      ? Deferred.succeed(reported, undefined).pipe(Effect.asVoid) : Effect.void)
    const publish = bus.publish
    const paused: Bus.Interface["publish"] = (definition, data, options) => publish(definition, data, options).pipe(Effect.tap((event) =>
      event.type === SessionEvent.InboxEnqueued.type && event.durable?.aggregateID === steer.run.childSessionID
        ? Effect.die("lost committed publication response") : Effect.void))
    const spy = spyOn(bus, "publish").mockImplementation(paused)
    yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()))
    expect((yield* host.experimental.subagent.steer(steer).pipe(Effect.exit))._tag).toBe("Failure")
    spy.mockRestore()
    yield* sessions.interrupt(steer.run.childSessionID)
    const final = yield* host.experimental.subagent.wait({ run: steer.run }).pipe(Effect.timeout("2 seconds"))
    expect(final.receipt).toMatchObject({ status: "cancelled", error: expect.stringContaining("clarification") })
    yield* Deferred.await(reported).pipe(Effect.timeout("2 seconds"))
    expect(yield* sessions.inbox(steer.run.childSessionID)).toEqual([])
    expect((yield* sessions.inbox(parent.id)).filter((item) => item.type === "synthetic")).toHaveLength(1)
  }))
})
