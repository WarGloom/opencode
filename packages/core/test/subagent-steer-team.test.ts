import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { Agent } from "@opencode/core/agent"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { SessionEvent } from "@opencode/core/session/event"
import { admissionFixture, admissionTests } from "./fixture/subagent-admission"

describe("team steer authority", () => {
  admissionTests.live("rejects an anchor revoked during hooks without enqueueing a clarification", () => Effect.gen(function* () {
    const { sessions, host, input, parent, bus, llm, invokingMessageID } = yield* admissionFixture
    const build = Agent.ID.make("build")
    yield* sessions.setPermissions({ sessionID: parent.id, permissions: [{ action: "subagent", resource: "build", effect: "allow" }] })
    yield* bus.publish(SessionEvent.Tool.Input.Started, { sessionID: parent.id, assistantMessageID: invokingMessageID, id: "team-add", name: "team_add_member" })
    const anchor = yield* host.experimental.subagent.prepare({ ...input, admissionID: "anchor", agent: build, target: { kind: "create" },
      invocation: { ...input.invocation, toolCallID: "team-add", team: { teamRunID: "team", member: "member" } } })
    yield* host.experimental.subagent.start({ admissionID: anchor.admissionID, prompt: { text: "provision" }, delivery: "queue", mode: "foreground", completion: "none" }).pipe(Effect.timeout("2 seconds"))
    const prepared = yield* host.experimental.subagent.prepare({ ...input, admissionID: "mailbox", agent: build, target: { kind: "existing", sessionID: anchor.childSessionID },
      invocation: { kind: "team", agent: build, invocationID: "mail", teamRunID: "team", member: "member", provisioningAdmissionID: anchor.admissionID } })
    const gate = yield* llm.gate()
    const started = yield* host.experimental.subagent.start({ admissionID: prepared.admissionID, prompt: { text: "team work" }, delivery: "queue", mode: "background", completion: "none" })
    if (!started.run) throw new Error("Native start omitted its run")
    yield* gate.started.pipe(Effect.timeout("2 seconds"))
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
    const locations = yield* LocationServiceMap.Service
    const hooks = yield* PluginHooks.Service.pipe(Effect.provide(locations.get(parent.location)))
    yield* hooks.register("session", "prompt", () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
    const joining = yield* host.experimental.subagent.steer({ admissionID: prepared.admissionID, run: started.run, invocation: input.invocation, prompt: { text: "revoked clarification" } }).pipe(Effect.result, Effect.forkChild({ startImmediately: true }))
    yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))
    yield* host.experimental.subagent.cancel({ admissionID: anchor.admissionID })
    yield* Deferred.succeed(release, undefined)
    expect(yield* Fiber.join(joining).pipe(Effect.timeout("2 seconds"))).toMatchObject({ _tag: "Failure", failure: { reason: "Provisioning anchor revoked" } })
    expect(yield* sessions.inbox(started.run.childSessionID)).toEqual([])
    expect((yield* host.experimental.subagent.get({ admissionID: prepared.admissionID }))?.status).toBe("cancelled")
  }))
})
