import { describe, expect } from "bun:test"
import { LanguageModel, LLMClient } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import { Bus } from "@opencode/core/bus"
import { Agent } from "@opencode/core/agent"
import { Config } from "@opencode/core/config"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { Job } from "@opencode/core/job"
import { Location } from "@opencode/core/location"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionTitle } from "@opencode/core/session/title"
import { Snapshot } from "@opencode/core/snapshot"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Context, Deferred, Effect, Fiber, Layer, Scope, Stream } from "effect"
import { testEffect } from "./lib/effect"
import { offlineModels } from "./fixture/models"
import { tempLocationLayer } from "./fixture/location"

class AdmissionInterleave extends Context.Service<AdmissionInterleave, { effect: Effect.Effect<void> }>()("test/AdmissionInterleave") {}
const model = SessionRunnerModel.resolved(
  LanguageModel.make({ id: "idle-model", provider: "test", route: OpenAIChat.route }),
  { capabilities: { tools: true, input: ["text"], output: ["text"] }, cost: [], limit: { context: 200_000, output: 32_000 } },
)
const it = testEffect(Layer.unwrap(Effect.gen(function* () {
  const llm = yield* TestLLM.Test
  const interleave = { effect: Effect.void }
  return AppNodeBuilder.build(LayerNode.group([PluginHost.requirements, Plugin.node, SessionInbox.node, SessionExecution.node, Job.node]), [
    offlineModels,
    Config.node.replace(Config.testLayer([])),
    Agent.node.replace(Agent.node.mapLayer((base) => Layer.tap(base, (context) =>
      Context.get(context, Agent.Service).transform((editor) => editor.update(Agent.defaultID, (agent) => { agent.mode = "primary" })),
    ))),
    InstructionDiscovery.node.replace(InstructionDiscovery.configured({ project: false, global: false })),
    Location.node.replace(tempLocationLayer),
    llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
    SessionRunnerModel.node.replace(Layer.mock(SessionRunnerModel.Service, { resolve: () => Effect.succeed(model) })),
    SessionTitle.node.replace(Layer.succeed(SessionTitle.Service, { generate: () => Effect.void })),
    Snapshot.node.replace(Snapshot.noopLayer),
    PluginSupervisor.node.replace(Layer.empty),
    Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void, list: () => Effect.succeed([]) })),
    Bus.node.replace(Bus.node.mapLayer((base) => Layer.effect(Bus.Service, Effect.gen(function* () {
      const bus = yield* Bus.Service
      return Bus.Service.of({ ...bus, publishAll: (events) => Effect.gen(function* () {
        const effect = interleave.effect
        interleave.effect = Effect.void
        yield* effect
        return yield* bus.publishAll(events)
      }) })
    })).pipe(Layer.provide(base)))),
  ]).pipe(Layer.merge(Layer.succeed(AdmissionInterleave, interleave)))
})).pipe(Layer.provideMerge(TestLLM.testLayer())))

const setup = Effect.gen(function* () {
  const llm = yield* TestLLM.Test
  const bus = yield* Bus.Service
  const location = yield* Location.Service
  const plugins = yield* Plugin.Service
  const beforePublish = yield* AdmissionInterleave
  const inbox = yield* SessionInbox.Service
  const execution = yield* SessionExecution.Service
  const sessions = yield* Session.Service
  const jobs = yield* Job.Service
  const host = yield* PluginHost.make(plugins, "idle-continuation")
  const session = yield* sessions.create({ location: { directory: location.directory }, title: "Idle test", model: model.ref })
  const sessionID = session.id
  const started: string[] = []
  yield* bus.subscribe(SessionEvent.Execution.Started).pipe(
    Stream.filter((event) => event.data.sessionID === sessionID),
    Stream.runForEach((event) => Effect.sync(() => void started.push(event.id))),
    Effect.forkScoped({ startImmediately: true }),
  )
  yield* llm.push(TestLLM.text("Done", "initial"))
  const user = yield* sessions.prompt({ sessionID, text: "Start", resume: false })
  yield* sessions.resume(sessionID)
  const [boundary] = yield* sessions.messages({ sessionID, order: "desc", limit: 1 })
  if (boundary?.type !== "idle" || boundary.outcome !== "succeeded") throw new Error("Expected actual succeeded settlement")
  expect(yield* execution.isActive(sessionID)).toBe(false)
  expect(yield* llm.requests()).toHaveLength(1)
  const request = { sessionID, boundaryID: boundary.id, id: SessionMessage.ID.create(), text: "Continue", description: "Idle continuation" }
  const continueIdle = (input = request) => host.experimental.session.continueAfterIdle(input)
  const drain = Effect.gen(function* () {
    yield* llm.wait(2)
    yield* execution.awaitIdle(sessionID)
  })
  const unchanged = Effect.gen(function* () {
    yield* execution.awaitIdle(sessionID)
    expect(yield* execution.isActive(sessionID)).toBe(false)
    expect(yield* llm.requests()).toHaveLength(1)
    expect(started).toHaveLength(1)
  })
  return { host, sessions, execution, inbox, jobs, bus, llm, sessionID, user, request, continueIdle, drain, unchanged, beforePublish, started }
})
type Fixture = Effect.Success<typeof setup>
const scenario = (name: string, body: (s: Fixture) => Effect.Effect<void, unknown, Scope.Scope>) => it.live(name, () =>
  Effect.gen(function* () { yield* body(yield* setup) }),
)

describe("experimental.session.continueAfterIdle", () => {
  scenario("admits after actual settlement, wakes one model request, and reconciles delivered replay", (s) => Effect.gen(function* () {
    yield* s.llm.push(TestLLM.text("Continued", "continued"))
    const drained = yield* s.drain.pipe(Effect.forkChild({ startImmediately: true }))
    expect(yield* s.continueIdle()).toBe("admitted")
    expect(yield* s.continueIdle()).toBe("duplicate")
    yield* Fiber.join(drained)
    expect(yield* s.continueIdle()).toBe("duplicate")
    yield* s.execution.awaitIdle(s.sessionID)
    expect(yield* s.llm.requests()).toHaveLength(2)
    expect(s.started).toHaveLength(2)
    expect((yield* s.sessions.messages({ sessionID: s.sessionID })).filter((item) => item.id === s.request.id))
      .toMatchObject([{ type: "synthetic", text: "Continue", description: "Idle continuation" }])
    expect(yield* s.sessions.inbox(s.sessionID)).toEqual([])
  }))

  scenario("leaves resume:false user work pending without execution", (s) => Effect.gen(function* () {
    const user = yield* s.sessions.prompt({ sessionID: s.sessionID, text: "Parked", resume: false })
    expect(yield* s.continueIdle()).toBe("stale")
    yield* s.unchanged
    expect((yield* s.sessions.inbox(s.sessionID)).map((item) => [item.id, item.type])).toEqual([[user.id, "user"]])
  }))

  scenario("rejects the old boundary after a later resumed user execution settles", (s) => Effect.gen(function* () {
    yield* s.llm.push(TestLLM.text("Later", "later"))
    yield* s.sessions.prompt({ sessionID: s.sessionID, text: "Later user", resume: false })
    yield* s.sessions.resume(s.sessionID)
    expect(yield* s.continueIdle()).toBe("stale")
    yield* s.execution.awaitIdle(s.sessionID)
    expect(yield* s.llm.requests()).toHaveLength(2)
    expect(yield* s.sessions.inbox(s.sessionID)).toEqual([])
  }))

  scenario("blocks unresolved preparations but admits the same boundary after cancellation", (s) => Effect.gen(function* () {
    const preparation = { sessionID: s.sessionID, admissionID: `adm_${s.sessionID}`, childSessionID: Session.ID.create() }
    yield* s.inbox.prepareChild(preparation)
    expect(yield* s.continueIdle()).toBe("stale")
    yield* s.unchanged
    expect(yield* s.sessions.inbox(s.sessionID)).toEqual([])
    yield* s.inbox.resolveChild({ ...preparation, outcome: "cancelled" })
    yield* s.llm.push(TestLLM.text("Resumed", "resolved"))
    const drained = yield* s.drain.pipe(Effect.forkChild({ startImmediately: true }))
    expect(yield* s.continueIdle()).toBe("admitted")
    yield* Fiber.join(drained)
    expect(yield* s.llm.requests()).toHaveLength(2)
  }))

  for (const outcome of ["failed", "interrupted"] as const) {
    scenario(`rejects a ${outcome} idle boundary`, (s) => Effect.gen(function* () {
      yield* (outcome === "failed"
        ? s.bus.publish(SessionEvent.Execution.Failed, { sessionID: s.sessionID, error: { type: "unknown", message: "failed" } })
        : s.bus.publish(SessionEvent.Execution.Interrupted, { sessionID: s.sessionID, reason: "user" }))
      const [boundary] = yield* s.sessions.messages({ sessionID: s.sessionID, order: "desc", limit: 1 })
      if (!boundary) throw new Error("Expected terminal boundary")
      expect(yield* s.continueIdle({ ...s.request, boundaryID: boundary.id })).toBe("stale")
      yield* s.unchanged
      expect(yield* s.sessions.inbox(s.sessionID)).toEqual([])
    }))
  }

  scenario("admits at most one distinct id racing on a boundary and deduplicates its replay", (s) => Effect.gen(function* () {
    yield* s.llm.push(TestLLM.text("Winner", "race"))
    const gate = yield* s.llm.gate()
    const inputs = [s.request, { ...s.request, id: SessionMessage.ID.create(), text: "Competitor" }]
    const results = yield* Effect.all(inputs.map(s.continueIdle), { concurrency: "unbounded" })
    expect(results.toSorted()).toEqual(["admitted", "stale"])
    yield* gate.started
    const winner = inputs[results.indexOf("admitted")]
    if (!winner) throw new Error("Expected one winner")
    expect(yield* s.continueIdle(winner)).toBe("duplicate")
    yield* gate.release
    yield* s.execution.awaitIdle(s.sessionID)
    expect(yield* s.llm.requests()).toHaveLength(2)
  }))

  scenario("accepts an unchanged semantic idle after title and metadata changes", (s) => Effect.gen(function* () {
    yield* s.sessions.rename({ sessionID: s.sessionID, title: "Renamed" })
    yield* s.sessions.setMetadata({ sessionID: s.sessionID, metadata: { test: true } })
    yield* s.llm.push(TestLLM.text("Continued", "metadata"))
    const drained = yield* s.drain.pipe(Effect.forkChild({ startImmediately: true }))
    expect(yield* s.continueIdle()).toBe("admitted")
    yield* Fiber.join(drained)
    expect(yield* s.llm.requests()).toHaveLength(2)
  }))

  scenario("rejects a staged revert without leaving synthetic work", (s) => Effect.gen(function* () {
    yield* s.sessions.revert.stage({ sessionID: s.sessionID, messageID: s.user.id, files: false })
    expect(yield* s.continueIdle()).toBe("stale")
    yield* s.unchanged
    expect(yield* s.sessions.inbox(s.sessionID)).toEqual([])
  }))

  scenario("retains the expected-sequence CAS between semantic capture and publication", (s) => Effect.gen(function* () {
    s.beforePublish.effect = s.bus.publish(SessionEvent.Renamed, { sessionID: s.sessionID, title: "Concurrent title" }).pipe(Effect.asVoid)
    expect(yield* s.continueIdle()).toBe("stale")
    yield* s.unchanged
    expect(yield* s.sessions.inbox(s.sessionID)).toEqual([])
    expect((yield* s.sessions.get(s.sessionID)).title).toBe("Concurrent title")
  }))

  for (const completion of ["parent", "none"] as const) {
    scenario(`fences a running child with completion ${completion}`, (s) => Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const child = Session.ID.create()
      yield* s.jobs.start({ id: child, type: "subagent", recovery: {
        kind: "subagent", parentSessionID: s.sessionID, childSessionID: child,
        agent: "build", description: "Outstanding child", completion,
      }, run: Deferred.await(release).pipe(Effect.as("Done")) })
      yield* s.jobs.background(child)
      yield* s.llm.push(TestLLM.text("Continued", "child-control"))
      expect(yield* s.continueIdle()).toBe(completion === "parent" ? "stale" : "admitted")
      if (completion === "parent") {
        yield* s.unchanged
        expect(yield* s.sessions.inbox(s.sessionID)).toEqual([])
      }
      if (completion === "none") yield* s.drain
      yield* Deferred.succeed(release, undefined)
      yield* s.jobs.wait({ id: child })
    }))
  }
})
