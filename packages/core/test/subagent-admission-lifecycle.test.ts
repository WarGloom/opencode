import { describe, expect, spyOn } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer, Schema, Scope, Exit } from "effect"
import { LanguageModel } from "@opencode/ai/effect"
import { LLMClient } from "@opencode/ai/route"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Job } from "@opencode/core/job"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import type { SubagentDomain } from "@opencode/plugin/effect/subagent"
import { SubagentAdmission } from "@opencode/core/session/subagent-admission"
import { SubagentAdmissionRun } from "@opencode/core/session/subagent-admission-run"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionEvent } from "@opencode/core/session/event"
import { Bus } from "@opencode/core/bus"
import { SubagentAdmissionStore } from "@opencode/core/session/subagent-admission-store"
import { SubagentCompletion } from "@opencode/core/session/subagent-completion"
import { SessionRestart } from "@opencode/core/session/execution/restart"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInterruptJournal } from "@opencode/core/session/interrupt-journal"
import { KV } from "@opencode/core/kv"
import { Instance } from "@opencode/core/instance/service"
import { Database } from "@opencode/core/database/database"
import { SessionStore } from "@opencode/core/session/store"
import { Provider } from "@opencode/core/provider"
import { Permission } from "@opencode/core/permission"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { Skill } from "@opencode/schema/skill"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const llmLayer = TestLLM.testLayer({ fallback: TestLLM.text("Review complete", "review") })
const it = testEffect(
  Layer.merge(
    llmLayer,
    AppNodeBuilder.build(LayerNode.group([Session.node, Job.node, Bus.node, Database.node, KV.node, SessionStore.node, SessionInbox.node, Instance.node, LocationServiceMap.node, SubagentAdmissionStore.node, SessionRestart.node, SessionExecution.node]), [
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      Watcher.node.replace(Watcher.configured({ enabled: false })),
      LayerNodePlatform.llmClient.replace(llmLayer),
      SessionRunnerModel.node.replace(
        Layer.succeed(SessionRunnerModel.Service, {
          resolve: () =>
            Effect.succeed(
              SessionRunnerModel.resolved(
                LanguageModel.make({ id: "review", provider: "test", route: OpenAIChat.route }),
                {
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                  cost: [],
                  limit: { context: 200_000, output: 32_000 },
                },
              ),
            ),
        }),
      ),
    ]),
  ),
)

const admissionFixture = Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(`${dir.path}/opencode.json`, JSON.stringify({
        agents: { reviewer: { mode: "subagent" } },
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      })))
      yield* Effect.promise(() => Bun.write(`${dir.path}/.opencode/skills/review-guide/SKILL.md`, "---\nname: review-guide\ndescription: Review guidance\n---\nReview with $ARGUMENTS\n"))
      const sessions = yield* Session.Service
      const locations = yield* LocationServiceMap.Service
      const llm = yield* TestLLM.Test
      const model = Model.Ref.make({ id: Model.ID.make("review"), providerID: Provider.ID.make("test") })
      const parent = yield* sessions.create({ location: { directory: AbsolutePath.make(dir.path) }, agent: Agent.ID.make("build"), model })
      const host = yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        yield* plugins.awaitActivation
        const providers = yield* Provider.Service
        yield* providers.transform((editor) => editor.models.update(model.providerID, model.id, () => {}))
        const admission = yield* SubagentAdmission.Service
        const runs = yield* SubagentAdmissionRun.Service
        const permission = yield* Permission.Service
        const subagent: SubagentDomain = {
          prepare: (input) => admission.prepare("lifetime-owner", input),
          acceptSkills: (input) => runs.acceptSkills("lifetime-owner", input),
          start: (input) => runs.start("lifetime-owner", input),
          get: (input) => runs.get("lifetime-owner", input),
          wait: (input) => runs.wait("lifetime-owner", input),
          cancel: (input) => runs.cancel("lifetime-owner", input),
          reconcile: (input) => runs.reconcile("lifetime-owner", input),
          ready: (input) => runs.ready("lifetime-owner", input),
        }
        return { experimental: { subagent }, permission }
      }).pipe(Effect.provide(locations.get(parent.location)))
      const bus = yield* Bus.Service
      const invokingMessageID = SessionMessage.ID.create()
      yield* bus.publish(SessionEvent.Step.Started, { sessionID: parent.id, assistantMessageID: invokingMessageID, agent: Agent.ID.make("build"), model, started: 0 })
      yield* bus.publish(SessionEvent.Tool.Input.Started, { sessionID: parent.id, assistantMessageID: invokingMessageID, id: "native-admission-call", name: "task" })
      yield* bus.publish(SessionEvent.Tool.Input.Started, { sessionID: parent.id, assistantMessageID: invokingMessageID, id: "omo-agent-call", name: "call_omo_agent" })
      yield* sessions.setPermissions({ sessionID: parent.id, permissions: [{ action: "subagent", resource: "reviewer", effect: "ask" }] })
      const input = {
        parentSessionID: parent.id, agent: Agent.ID.make("reviewer"), model, maxDepth: 3, description: "Native lifetime",
        invocation: { kind: "tool" as const, agent: Agent.ID.make("build"), messageID: invokingMessageID, toolCallID: "native-admission-call" },
      }
      return { sessions, host, input, bus, parent, llm, invokingMessageID }
})

describe("subagent admission lifecycle", () => {
  it.live("output-model gate leaves host-generated no-text output unattributed", () =>
    Effect.gen(function* () {
      const { sessions, host, input, parent, llm } = yield* admissionFixture
      yield* sessions.setPermissions({ sessionID: parent.id, permissions: [{ action: "subagent", resource: "reviewer", effect: "allow" }] })
      yield* llm.push(TestLLM.stop())
      const prepared = yield* host.experimental.subagent.prepare({ ...input, admissionID: "output-model-no-text", target: { kind: "create" } })
      const receipt = yield* host.experimental.subagent.start({ admissionID: prepared.admissionID, prompt: { text: "inspect" }, delivery: "queue", mode: "foreground", completion: "none" }).pipe(Effect.timeout("2 seconds"))
      expect(receipt.status).toBe("completed")
      expect(receipt.output).toBe(SubagentCompletion.NO_TEXT)
      expect(receipt.outputModel).toBeUndefined()
    }),
  )

  it.live("output-model gate attributes actual text even when it equals the no-text fallback", () =>
    Effect.gen(function* () {
      const { sessions, host, input, parent, llm } = yield* admissionFixture
      yield* sessions.setPermissions({ sessionID: parent.id, permissions: [{ action: "subagent", resource: "reviewer", effect: "allow" }] })
      yield* llm.push(TestLLM.text(SubagentCompletion.NO_TEXT, "fallback-text"))
      const prepared = yield* host.experimental.subagent.prepare({ ...input, admissionID: "output-model-fallback-text", target: { kind: "create" } })
      const receipt = yield* host.experimental.subagent.start({ admissionID: prepared.admissionID, prompt: { text: "inspect" }, delivery: "queue", mode: "foreground", completion: "none" }).pipe(Effect.timeout("2 seconds"))
      expect(receipt.status).toBe("completed")
      expect(receipt.output).toBe(SubagentCompletion.NO_TEXT)
      expect(receipt.outputModel).toEqual(input.model)
    }),
  )

  it.live("output-model gate keeps a successful result when the optional observation defects", () =>
    Effect.gen(function* () {
      const { sessions, host, input, parent } = yield* admissionFixture
      yield* sessions.setPermissions({ sessionID: parent.id, permissions: [{ action: "subagent", resource: "reviewer", effect: "allow" }] })
      const store = yield* SessionStore.Service
      const observer = spyOn(store, "lastAssistantAfter").mockImplementation(() => Effect.die(new Error("Synthetic observation failure")))
      yield* Effect.addFinalizer(() => Effect.sync(() => observer.mockRestore()))
      const prepared = yield* host.experimental.subagent.prepare({ ...input, admissionID: "output-model-observation-defect", target: { kind: "create" } })
      const receipt = yield* host.experimental.subagent.start({ admissionID: prepared.admissionID, prompt: { text: "inspect" }, delivery: "queue", mode: "foreground", completion: "none" }).pipe(Effect.timeout("2 seconds"))
      expect(receipt.status).toBe("completed")
      expect(receipt.output).toBe("Review complete")
      expect(receipt.outputModel).toBeUndefined()
    }),
  )

  it.live("output-model gate propagates interruption of the optional observation", () =>
    Effect.gen(function* () {
      const { sessions, host, input, parent } = yield* admissionFixture
      yield* sessions.setPermissions({ sessionID: parent.id, permissions: [{ action: "subagent", resource: "reviewer", effect: "allow" }] })
      const store = yield* SessionStore.Service
      const observer = spyOn(store, "lastAssistantAfter").mockImplementation(() => Effect.interrupt)
      yield* Effect.addFinalizer(() => Effect.sync(() => observer.mockRestore()))
      const prepared = yield* host.experimental.subagent.prepare({ ...input, admissionID: "output-model-observation-interrupted", target: { kind: "create" } })
      const receipt = yield* host.experimental.subagent.start({ admissionID: prepared.admissionID, prompt: { text: "inspect" }, delivery: "queue", mode: "foreground", completion: "none" }).pipe(Effect.timeout("2 seconds"))
      expect(receipt.status).toBe("cancelled")
      expect(receipt.outputModel).toBeUndefined()
    }),
  )

  for (const observed of [true, false]) {
    it.live(`reports the output-producing model only when generation evidence is ${observed ? "available" : "missing"}`, () =>
      Effect.gen(function* () {
        const { sessions, host, input, parent } = yield* admissionFixture
        yield* sessions.setPermissions({ sessionID: parent.id, permissions: [{ action: "subagent", resource: "reviewer", effect: "allow" }] })
        const selected = Model.Ref.make({ providerID: input.model.providerID, id: Model.ID.make("selected") })
        const locations = yield* LocationServiceMap.Service
        yield* Effect.gen(function* () {
          const providers = yield* Provider.Service
          yield* providers.transform((editor) => editor.models.update(selected.providerID, selected.id, () => {}))
        }).pipe(Effect.provide(locations.get(parent.location)))
        if (!observed) {
          const store = yield* SessionStore.Service
          const observer = spyOn(store, "lastAssistantAfter").mockImplementation(() => Effect.succeed(undefined))
          yield* Effect.addFinalizer(() => Effect.sync(() => observer.mockRestore()))
        }
        const prepared = yield* host.experimental.subagent.prepare({ ...input, model: selected, admissionID: `output-model-${observed}`, target: { kind: "create" } })
        const receipt = yield* host.experimental.subagent.start({ admissionID: prepared.admissionID, prompt: { text: "inspect" }, delivery: "queue", mode: "foreground", completion: "none" }).pipe(Effect.timeout("2 seconds"))
        expect(receipt.status).toBe("completed")
        expect(receipt.outputModel).toEqual(observed ? input.model : undefined)
      }),
    )
  }

  it.live("restarts a running admission after a model change with its original generation and initial model", () =>
    Effect.gen(function* () {
      // given
      const { sessions, host, input, parent, llm, bus } = yield* admissionFixture
      yield* sessions.setPermissions({ sessionID: parent.id, permissions: [{ action: "subagent", resource: "reviewer", effect: "allow" }] })
      const prepared = yield* host.experimental.subagent.prepare({ ...input, admissionID: "restart-model-change", target: { kind: "create" } })
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const admissions = yield* SubagentAdmissionStore.Service
        const ownership = AppNodeBuilder.build(LayerNode.group([Session.node, Job.node, SessionExecution.node, LocationServiceMap.node]), [
          Database.node.replace(Layer.succeed(Database.Service, yield* Database.Service)),
          Bus.node.replace(Layer.succeed(Bus.Service, bus)),
          SessionProjector.node.replace(Layer.empty),
          KV.node.replace(Layer.succeed(KV.Service, yield* KV.Service)),
          SubagentAdmissionStore.node.replace(Layer.succeed(SubagentAdmissionStore.Service, admissions)),
          Global.node.replace(tempGlobalLayer),
          offlineModels,
          Watcher.node.replace(Watcher.configured({ enabled: false })),
          LayerNodePlatform.llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
          SessionRunnerModel.node.replace(Layer.succeed(SessionRunnerModel.Service, {
            resolve: () => Effect.succeed(SessionRunnerModel.resolved(
              LanguageModel.make({ id: "review", provider: "test", route: OpenAIChat.route }),
              { capabilities: { tools: true, input: ["text"], output: ["text"] }, cost: [], limit: { context: 200_000, output: 32_000 } },
            )),
          })),
        ])
        const originalScope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(originalScope, Exit.void))
        const original = yield* Layer.buildWithScope(Layer.fresh(ownership), originalScope)
        const originalLocations = Context.get(original, LocationServiceMap.Service)
        const originalRuns = yield* SubagentAdmissionRun.Service.pipe(Effect.provide(originalLocations.get(parent.location)))
        const model = Model.Ref.make({ providerID: input.model.providerID, id: Model.ID.make("fallback"), variant: Model.VariantID.make("high") })
        const start = { admissionID: prepared.admissionID, prompt: { text: "restart after model change" }, delivery: "queue" as const, mode: "background" as const, completion: "parent" as const }
        yield* sessions.switchModel({ sessionID: prepared.childSessionID, model })
        expect(yield* originalRuns.start("lifetime-owner", start).pipe(Effect.flip)).toMatchObject({ reason: "Prepared child binding changed" })
        yield* sessions.switchModel({ sessionID: prepared.childSessionID, model: input.model })
        const primary = yield* llm.gate()
        yield* Effect.addFinalizer(() => primary.release)
        const started = yield* originalRuns.start("lifetime-owner", start)
        if (started.run === undefined) throw new Error("Native start omitted its run reference")
        const run = started.run
        yield* primary.started.pipe(Effect.timeout("2 seconds"))

        // when
        yield* Scope.close(originalScope, Exit.void)
        yield* sessions.switchModel({ sessionID: prepared.childSessionID, model })
        const restartedScope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(restartedScope, Exit.void))
        const restarted = yield* Layer.buildWithScope(Layer.fresh(ownership), restartedScope)
        const jobs = Context.get(restarted, Job.Service)
        const restartedLocations = Context.get(restarted, LocationServiceMap.Service)
        const runs = yield* SubagentAdmissionRun.Service.pipe(Effect.provide(restartedLocations.get(parent.location)))
        expect(yield* jobs.get(run.childSessionID)).toBeUndefined()
        expect((yield* jobs.pendingBackground).map((job) => [job.status, job.recovery])).toEqual([["running", expect.objectContaining({ pluginID: "lifetime-owner", generation: run.generation, parentSessionID: parent.id, childSessionID: run.childSessionID, agent: input.agent })]])
        const completion = yield* Deferred.make<void>()
        yield* bus.listen((event) => event.type === SessionEvent.InboxEnqueued.type && event.durable?.aggregateID === parent.id
          ? Deferred.succeed(completion, undefined).pipe(Effect.asVoid) : Effect.void)
        const resumed = yield* llm.gate()
        yield* Effect.addFinalizer(() => resumed.release)
        const ready = yield* runs.ready("lifetime-owner", { run }).pipe(Effect.timeout("2 seconds"))

        // then
        expect(ready).toMatchObject({ status: "running", run })
        expect((yield* jobs.get(run.childSessionID))?.generation).toBe(run.generation)
        expect((yield* sessions.get(run.childSessionID)).model).toEqual(model)
        expect((yield* admissions.get("lifetime-owner", prepared.admissionID))?.model).toEqual(input.model)
        yield* resumed.started.pipe(Effect.timeout("2 seconds"))
        yield* resumed.release
        expect((yield* runs.wait("lifetime-owner", { run }).pipe(Effect.timeout("2 seconds"))).receipt).toMatchObject({ status: "completed", run, output: "Review complete" })
        yield* Deferred.await(completion).pipe(Effect.timeout("2 seconds"))
        yield* runs.ready("lifetime-owner", { run })
        expect((yield* sessions.inbox(parent.id)).filter((item) => item.type === "synthetic")).toHaveLength(1)
      }).pipe(Effect.provide(locations.get(parent.location)))
    }),
  )

  it.live("preserves a delegated generation through a plugin timeout and delivers its recovered result once", () =>
    Effect.gen(function* () {
      // given
      const { sessions, host, input, bus, parent, llm } = yield* admissionFixture
      yield* sessions.setPermissions({ sessionID: parent.id, permissions: [{ action: "subagent", resource: "reviewer", effect: "allow" }] })
      const completion = yield* Deferred.make<void>()
      yield* bus.listen((event) => event.type === SessionEvent.InboxEnqueued.type && event.durable?.aggregateID === parent.id
        ? Deferred.succeed(completion, undefined).pipe(Effect.asVoid) : Effect.void)
      const prepared = yield* host.experimental.subagent.prepare({ ...input, admissionID: "recover-timeout", target: { kind: "create" } })
      const primary = yield* llm.gate()
      yield* Effect.addFinalizer(() => primary.release)
      const started = yield* host.experimental.subagent.start({ admissionID: prepared.admissionID, prompt: { text: "recover timeout" }, delivery: "queue", mode: "background", completion: "parent" })
      if (started.run === undefined) throw new Error("Native start omitted its run reference")
      const run = started.run
      yield* primary.started.pipe(Effect.timeout("2 seconds"))

      // when
      const fallback = yield* llm.gate()
      yield* Effect.addFinalizer(() => fallback.release)
      const owner = { pluginID: "lifetime-owner", lifetime: "timeout-test" }
      expect(yield* sessions.recover({ sessionID: prepared.childSessionID, owner }, (boundaryID) => Effect.gen(function* () {
        expect((yield* host.experimental.subagent.get({ run }))?.status).toBe("running")
        expect(yield* sessions.recover({ sessionID: prepared.childSessionID, owner }, () => Effect.die("Duplicate recovery callback ran"))).toBe(false)
        const recovery = { sessionID: prepared.childSessionID, boundaryID, id: SessionMessage.ID.create(), text: "Continue the existing task after the model timeout.", recovery: owner }
        expect(yield* sessions.continueAfterFailure(recovery)).toBe("admitted")
        expect(yield* sessions.continueAfterFailure(recovery)).toBe("duplicate")
        yield* sessions.closeRecovery(owner)
        return true
      }))).toBe(true)
      yield* fallback.started.pipe(Effect.timeout("2 seconds"))
      yield* fallback.release

      // then
      const final = yield* host.experimental.subagent.wait({ run: started.run }).pipe(Effect.timeout("2 seconds"))
      expect(final.receipt).toMatchObject({ status: "completed", run: started.run, output: "Review complete" })
      yield* Deferred.await(completion).pipe(Effect.timeout("2 seconds"))
      const pending = (yield* sessions.inbox(parent.id)).filter((item) => item.type === "synthetic")
      expect(pending).toHaveLength(1)
      expect(pending[0]?.type === "synthetic" && pending[0].payload.text).toContain("Review complete")
    }),
  )

  for (const scenario of ["ordinary", "cancel", "dispose", "decline", "throw", "stale", "newer"] as const) {
    it.live(`terminates the original delegated generation after ${scenario} without delayed revival`, () => Effect.gen(function* () {
      const { sessions, host, input, parent, llm } = yield* admissionFixture
      yield* sessions.setPermissions({ sessionID: parent.id, permissions: [{ action: "subagent", resource: "reviewer", effect: "allow" }] })
      const prepared = yield* host.experimental.subagent.prepare({ ...input, admissionID: scenario, target: { kind: "create" } })
      const primary = yield* llm.gate()
      yield* Effect.addFinalizer(() => primary.release)
      const started = yield* host.experimental.subagent.start({ admissionID: prepared.admissionID, prompt: { text: scenario }, delivery: "queue", mode: "background", completion: "none" })
      if (!started.run) throw new Error("Native start omitted its run")
      const run = started.run
      yield* primary.started.pipe(Effect.timeout("2 seconds"))
      const newer = scenario === "newer" ? yield* llm.gate() : undefined
      if (newer) yield* Effect.addFinalizer(() => newer.release)
      const owner = { pluginID: "lifetime-owner", lifetime: scenario }
      if (scenario === "ordinary") {
        yield* sessions.interrupt(prepared.childSessionID)
        yield* sessions.wait(prepared.childSessionID)
      } else {
        const result = yield* sessions.recover({ sessionID: prepared.childSessionID, owner }, (boundaryID) => Effect.gen(function* () {
          if (scenario === "throw") return yield* Effect.fail(new Error("fallback lookup failed"))
          if (scenario === "decline") return false
          if (scenario === "cancel") yield* sessions.interrupt(prepared.childSessionID)
          if (scenario === "dispose") yield* sessions.closeRecovery(owner)
          if (scenario === "stale") yield* sessions.synthetic({ sessionID: prepared.childSessionID, text: "newer input", resume: false })
          if (newer) {
            yield* sessions.synthetic({ sessionID: prepared.childSessionID, text: "newer execution" })
            yield* newer.started.pipe(Effect.timeout("2 seconds"))
          }
          expect(yield* sessions.continueAfterFailure({ sessionID: prepared.childSessionID, boundaryID, id: SessionMessage.ID.create(), text: "late fallback", recovery: owner })).toBe("stale")
          return false
        })).pipe(Effect.exit)
        expect(result._tag).toBe(scenario === "throw" ? "Failure" : "Success")
      }
      if (newer) {
        const execution = yield* SessionExecution.Service
        expect(yield* execution.isActive(prepared.childSessionID)).toBe(true)
        yield* newer.release
      }
      const final = yield* host.experimental.subagent.wait({ run }).pipe(Effect.timeout("2 seconds"))
      expect(final.receipt.status).toBe(scenario === "ordinary" || scenario === "cancel" ? "cancelled" : "error")
      if (scenario === "throw") expect(final.receipt.error).toContain("fallback lookup failed")
      if (scenario === "stale") expect((yield* sessions.inbox(prepared.childSessionID)).map((item) => item.type === "synthetic" && item.payload.text)).toEqual(["newer input"])
      expect(yield* sessions.inbox(parent.id)).toEqual([])
    }))
  }

  for (const committed of [false, true]) {
    it.live(`reconciles a restarted ${committed ? "committed" : "abandoned"} recovery without replaying a plugin callback`, () => Effect.gen(function* () {
      const { sessions, host, input, parent, llm } = yield* admissionFixture
      yield* sessions.setPermissions({ sessionID: parent.id, permissions: [{ action: "subagent", resource: "reviewer", effect: "allow" }] })
      const prepared = yield* host.experimental.subagent.prepare({ ...input, admissionID: `restart-${committed}`, target: { kind: "create" } })
      const gate = yield* llm.gate()
      yield* Effect.addFinalizer(() => gate.release)
      const started = yield* host.experimental.subagent.start({ admissionID: prepared.admissionID, prompt: { text: "restart recovery" }, delivery: "queue", mode: "background", completion: "none" })
      if (!started.run) throw new Error("Native start omitted its run")
      const run = started.run
      yield* gate.started.pipe(Effect.timeout("2 seconds"))
      yield* host.experimental.subagent.cancel({ run })
      yield* sessions.wait(prepared.childSessionID)
      yield* gate.release
      const kv = yield* KV.Service
      const journal = yield* SessionInterruptJournal.make(kv)
      const owner = { pluginID: "lifetime-owner", lifetime: "dead-plugin" }
      const attempt = yield* journal.begin(prepared.childSessionID, owner, run.generation)
      if (!attempt) throw new Error("Recovery attempt was not recorded")
      if (committed) {
        yield* sessions.synthetic({ sessionID: prepared.childSessionID, text: "durable accepted successor", resume: false })
        yield* journal.commit(attempt)
      }
      const restartedScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(restartedScope, Exit.void))
      const restarted = Context.get(yield* Layer.buildWithScope(Layer.fresh(SessionExecution.layer), restartedScope), SessionExecution.Service)
      expect(yield* restarted.recovery(prepared.childSessionID, run.generation).pipe(Effect.exit, Effect.map((result) => result._tag))).toBe(committed ? "Success" : "Failure")
      if (committed) {
        yield* restarted.resume(prepared.childSessionID).pipe(Effect.timeout("2 seconds"))
        expect((yield* sessions.get(prepared.childSessionID)).outcome).toBe("succeeded")
      } else {
        expect((yield* sessions.get(prepared.childSessionID)).outcome).toBe("failed")
        expect(yield* llm.requests()).toHaveLength(1)
      }
    }))
  }

  it.live("keeps owner cancellation final when recovery commits before its successor wake", () => Effect.gen(function* () {
    const { sessions, host, input, parent, llm, bus } = yield* admissionFixture
    yield* sessions.setPermissions({ sessionID: parent.id, permissions: [{ action: "subagent", resource: "reviewer", effect: "allow" }] })
    const prepared = yield* host.experimental.subagent.prepare({ ...input, admissionID: "commit-before-wake", target: { kind: "create" } })
    const primary = yield* llm.gate()
    yield* Effect.addFinalizer(() => primary.release)
    const started = yield* host.experimental.subagent.start({ admissionID: prepared.admissionID, prompt: { text: "commit race" }, delivery: "queue", mode: "background", completion: "parent" })
    if (!started.run) throw new Error("Native start omitted its run")
    const run = started.run
    yield* primary.started.pipe(Effect.timeout("2 seconds"))
    const fallback = yield* llm.gate()
    yield* Effect.addFinalizer(() => fallback.release)
    const committed = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
    const publishAll = bus.publishAll
    let hold = true
    const publication: Bus.Interface["publishAll"] = (events) => publishAll(events).pipe(Effect.tap((published) => {
      if (!hold || !published.some((event) => event.type === SessionEvent.InboxEnqueued.type && event.durable?.aggregateID === prepared.childSessionID)) return Effect.void
      hold = false
      return Deferred.succeed(committed, undefined).pipe(Effect.andThen(Deferred.await(release)))
    }))
    const spy = spyOn(bus, "publishAll").mockImplementation(publication)
    yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()))
    const owner = { pluginID: "lifetime-owner", lifetime: "commit-race" }
    const recovering = yield* sessions.recover({ sessionID: prepared.childSessionID, owner }, (boundaryID) => sessions.continueAfterFailure({ sessionID: prepared.childSessionID, boundaryID, id: SessionMessage.ID.create(), text: "accepted successor", recovery: owner }).pipe(Effect.as(true))).pipe(Effect.forkChild({ startImmediately: true }))
    yield* Deferred.await(committed).pipe(Effect.timeout("2 seconds"))
    const cancelling = yield* host.experimental.subagent.cancel({ run }).pipe(Effect.forkChild({ startImmediately: true }))
    yield* Deferred.succeed(release, undefined)
    expect((yield* Fiber.join(cancelling).pipe(Effect.timeout("2 seconds"))).status).toBe("cancelled")
    yield* Fiber.join(recovering).pipe(Effect.timeout("2 seconds"))
    const execution = yield* SessionExecution.Service
    yield* execution.awaitIdle(prepared.childSessionID).pipe(Effect.timeout("2 seconds"))
    expect((yield* host.experimental.subagent.get({ run }))?.status).toBe("cancelled")
    expect(yield* sessions.inbox(parent.id)).toEqual([])
  }))

  it.live("cancels a pending native permission request without a reply or child execution", () => Effect.gen(function* () {
      const { sessions, host, input, bus, parent } = yield* admissionFixture
      const waitingApproval = yield* Deferred.make<Permission.Request>()
      yield* bus.listen((event) => {
        if (event.type !== Permission.Event.Asked.type) return Effect.void
        const request = Schema.decodeUnknownSync(Schema.toType(Permission.Request))(event.data)
        if (request.sessionID !== parent.id) return Effect.void
        return Deferred.succeed(waitingApproval, request).pipe(Effect.asVoid)
      })
      const preparing = yield* host.experimental.subagent.prepare({ ...input, admissionID: "cancel-during-approval", target: { kind: "create" } }).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.raceFirst(
        Deferred.await(waitingApproval),
        Fiber.join(preparing).pipe(Effect.flatMap((receipt) => Effect.fail(new Error(`Preparation finished before approval: ${receipt.status}`)))),
      ).pipe(Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.fail(new Error("Native permission request was not emitted")) }))
      const cancelled = yield* host.experimental.subagent.cancel({ admissionID: "cancel-during-approval" })
      expect(cancelled.status).toBe("cancelled")
      const settled = yield* Fiber.join(preparing).pipe(Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.fail(new Error("Cancellation did not release the native permission waiter")) }))
      expect(settled.status).toBe("cancelled")
      expect(yield* host.permission.forSession(parent.id)).toEqual([])
      expect((yield* sessions.get(cancelled.childSessionID).pipe(Effect.result))._tag).toBe("Failure")
  }))

  it.live("records an owner cancellation without waking the parent while other cancellations still notify", () =>
    Effect.gen(function* () {
      const { sessions, host, input, bus, parent, llm } = yield* admissionFixture
      yield* bus.listen((event) => {
        if (event.type !== Permission.Event.Asked.type) return Effect.void
        const request = Schema.decodeUnknownSync(Schema.toType(Permission.Request))(event.data)
        if (request.sessionID !== parent.id) return Effect.void
        return host.permission.reply({ requestID: request.id, reply: "always" }).pipe(Effect.orDie)
      })
      const jobs = yield* Job.Service
      const notified = yield* Deferred.make<string>()
      yield* bus.listen((event) => {
        if (event.type !== SessionEvent.InboxEnqueued.type) return Effect.void
        const data = event.data as { sessionID: string; item: { type: string; payload: { metadata?: { childID?: string } } } }
        if (data.sessionID !== parent.id || data.item.type !== "synthetic") return Effect.void
        return Deferred.succeed(notified, data.item.payload.metadata?.childID ?? "").pipe(Effect.asVoid)
      })
      const held = Effect.fn(function* (admissionID: string) {
        yield* host.experimental.subagent.prepare({ ...input, admissionID, target: { kind: "create" } }).pipe(Effect.timeout("2 seconds"))
        const gate = yield* llm.gate()
        yield* Effect.addFinalizer(() => gate.release)
        const started = yield* host.experimental.subagent.start({ admissionID, prompt: { text: admissionID }, delivery: "queue", mode: "background", completion: "parent" })
        yield* gate.started.pipe(Effect.timeout("2 seconds"))
        if (started.run === undefined) throw new Error("Native start omitted its run reference")
        return started.run
      })

      // The owning plugin cancels: the outcome stays on the durable admission, its notification is consumed, and the
      // parent gets no completion wake.
      const owned = yield* held("owner-cancel")
      // A genuine timeout on the still-running job keeps reporting timedOut.
      expect(yield* host.experimental.subagent.wait({ run: owned, timeout: 0 }).pipe(Effect.map((result) => [result.receipt.status, result.timedOut])))
        .toEqual(["running", true])
      // A waiter that read the running entry is held at the Job wait until the owner cancel has stamped the entry
      // and consumed the Job, the worst interleaving for a wait that is in flight at cancel time.
      const blocked = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      const jobWait = jobs.wait
      const spy = spyOn(jobs, "wait").mockImplementation((request) =>
        request.timeout === undefined && request.id === owned.childSessionID
          ? Deferred.succeed(blocked, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(jobWait(request)))
          : jobWait(request))
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()))
      const waiting = yield* host.experimental.subagent.wait({ run: owned }).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(blocked).pipe(Effect.timeout("2 seconds"))
      expect((yield* host.experimental.subagent.cancel({ run: owned })).status).toBe("cancelled")
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(waiting).pipe(Effect.timeout("2 seconds"), Effect.map((result) => [result.receipt.status, result.timedOut])))
        .toEqual(["cancelled", false])
      spy.mockRestore()
      // A wait issued after the cancel also returns the durable terminal receipt.
      expect(yield* host.experimental.subagent.wait({ run: owned }).pipe(Effect.timeout("2 seconds"), Effect.map((result) => [result.receipt.status, result.timedOut])))
        .toEqual(["cancelled", false])
      expect((yield* host.experimental.subagent.get({ run: owned }))?.status).toBe("cancelled")
      expect((yield* jobs.pendingBackground).some((item) => item.recovery.kind === "subagent" && item.recovery.generation === owned.generation)).toBe(false)

      // Any other cancellation of a background child keeps today's completion wake. Its notification arrives
      // after the owner cancellation's observer already decided, so it is the first and only parent synthetic.
      const other = yield* held("job-cancel")
      yield* jobs.cancel(other.childSessionID, other.generation)
      expect(yield* Deferred.await(notified).pipe(Effect.timeout("2 seconds"))).toBe(other.childSessionID)
      const synthetics = (yield* sessions.inbox(parent.id)).filter((item) => item.type === "synthetic")
      expect(synthetics.map((item) => item.type === "synthetic" && item.payload.metadata?.childID)).toEqual([other.childSessionID])
    }),
  )

  it.live("keeps an adopted active period silent on owner cancellation but reports a later ordinary period", () =>
    Effect.gen(function* () {
      const { sessions, host, input, parent, llm, bus } = yield* admissionFixture
      yield* sessions.setPermissions({ sessionID: parent.id, permissions: [{ action: "subagent", resource: "reviewer", effect: "allow" }] })
      const child = yield* sessions.create({ parentID: parent.id, agent: input.agent, model: input.model, title: "adopted" })
      const gate = yield* llm.gate()
      yield* Effect.addFinalizer(() => gate.release)
      yield* sessions.prompt({ sessionID: child.id, text: "existing work" })
      yield* gate.started.pipe(Effect.timeout("2 seconds"))
      const prepared = yield* host.experimental.subagent.prepare({ ...input, admissionID: "adopt-active", target: { kind: "existing", sessionID: child.id } })
      const started = yield* host.experimental.subagent.start({ admissionID: prepared.admissionID, prompt: { text: "follow-up" }, delivery: "steer", mode: "background", completion: "parent" })
      if (!started.run) throw new Error("Native start omitted its run")
      const jobs = yield* Job.Service
      const reportStarted = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      const prepareReport = jobs.prepareSubagentReport
      const spy = spyOn(jobs, "prepareSubagentReport").mockImplementation((...args) =>
        Deferred.succeed(reportStarted, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(prepareReport(...args))),
      )
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()))
      expect((yield* host.experimental.subagent.cancel({ run: started.run })).status).toBe("cancelled")
      yield* Deferred.await(reportStarted).pipe(Effect.timeout("2 seconds"))
      yield* Deferred.succeed(release, undefined)
      yield* sessions.wait(child.id).pipe(Effect.timeout("2 seconds"))
      spy.mockRestore()
      expect(yield* sessions.inbox(parent.id)).toEqual([])
      const notified = yield* Deferred.make<void>()
      yield* bus.listen((event) => event.type === SessionEvent.InboxEnqueued.type && event.durable?.aggregateID === parent.id
        ? Deferred.succeed(notified, undefined).pipe(Effect.asVoid) : Effect.void)
      yield* gate.release
      yield* sessions.prompt({ sessionID: child.id, text: "ordinary follow-up" })
      yield* Deferred.await(notified).pipe(Effect.timeout("2 seconds"))
      const notices = (yield* sessions.inbox(parent.id)).filter((item) => item.type === "synthetic")
      expect(notices).toHaveLength(1)
      expect(notices[0]?.type === "synthetic" && notices[0].payload.text).toContain('state="completed"')
    }),
  )

  it.live("reports an adopted active period once when another caller cancels its job", () =>
    Effect.gen(function* () {
      const { sessions, host, input, parent, llm, bus } = yield* admissionFixture
      yield* sessions.setPermissions({ sessionID: parent.id, permissions: [{ action: "subagent", resource: "reviewer", effect: "allow" }] })
      const child = yield* sessions.create({ parentID: parent.id, agent: input.agent, model: input.model, title: "adopted" })
      const gate = yield* llm.gate()
      yield* Effect.addFinalizer(() => gate.release)
      yield* sessions.prompt({ sessionID: child.id, text: "existing work" })
      yield* gate.started.pipe(Effect.timeout("2 seconds"))
      const prepared = yield* host.experimental.subagent.prepare({ ...input, admissionID: "adopt-job-cancel", target: { kind: "existing", sessionID: child.id } })
      const started = yield* host.experimental.subagent.start({ admissionID: prepared.admissionID, prompt: { text: "follow-up" }, delivery: "steer", mode: "background", completion: "parent" })
      if (!started.run) throw new Error("Native start omitted its run")
      const nativeNotice = yield* Deferred.make<void>()
      const notificationID = `msg_subagent_${started.run.generation}`
      yield* bus.listen((event) => {
        if (event.type !== SessionEvent.InboxEnqueued.type || event.durable?.aggregateID !== parent.id) return Effect.void
        const data = Schema.decodeUnknownSync(Schema.toType(SessionEvent.InboxEnqueued.data))(event.data)
        return data.inboxID === notificationID ? Deferred.succeed(nativeNotice, undefined).pipe(Effect.asVoid) : Effect.void
      })
      const jobs = yield* Job.Service
      yield* jobs.cancel(child.id, started.run.generation).pipe(Effect.timeout("2 seconds"))
      yield* sessions.wait(child.id).pipe(Effect.timeout("2 seconds"))
      yield* Deferred.await(nativeNotice).pipe(Effect.timeout("2 seconds"))
      yield* gate.release
      yield* sessions.wait(parent.id).pipe(Effect.timeout("2 seconds"))
      const pending = (yield* sessions.inbox(parent.id)).filter((item) => item.type === "synthetic")
      const delivered = (yield* sessions.context(parent.id)).filter((item) => item.type === "synthetic")
      expect([...pending, ...delivered]).toHaveLength(1)
    }),
  )

  it.live("joins steering admitted during final settlement and rejects stale cancellation of a successor", () =>
    Effect.gen(function* () {
      const { sessions, host, input, bus, parent, llm, invokingMessageID } = yield* admissionFixture
      let approvals = 0
      yield* bus.listen((event) => {
        if (event.type !== Permission.Event.Asked.type) return Effect.void
        const request = Schema.decodeUnknownSync(Schema.toType(Permission.Request))(event.data)
        if (request.sessionID !== parent.id) return Effect.void
        approvals++
        return host.permission.reply({ requestID: request.id, reply: "once" }).pipe(Effect.orDie)
      })
      const first = yield* host.experimental.subagent.prepare({ ...input, admissionID: "first", target: { kind: "create" } }).pipe(Effect.timeout("2 seconds"))
      expect(approvals).toBe(1)
      yield* sessions.setPermissions({ sessionID: parent.id, permissions: [{ action: "subagent", resource: "reviewer", effect: "deny" }, { action: "call_omo_agent", resource: "reviewer", effect: "allow" }] })
      expect((yield* host.experimental.subagent.start({ admissionID: first.admissionID, prompt: { text: "denied" }, delivery: "queue", mode: "background", completion: "none" }).pipe(Effect.result))._tag).toBe("Failure")
      expect(yield* sessions.inbox(first.childSessionID)).toEqual([])
      const explore = yield* host.experimental.subagent.prepare({ ...input, admissionID: "omo-agent", invocation: { kind: "tool", agent: Agent.ID.make("build"), messageID: invokingMessageID, toolCallID: "omo-agent-call" }, target: { kind: "create" } })
      expect(explore.status).toBe("prepared")
      yield* host.experimental.subagent.cancel({ admissionID: explore.admissionID })
      yield* sessions.setPermissions({ sessionID: parent.id, permissions: [{ action: "subagent", resource: "reviewer", effect: "ask" }] })
      const finishing = yield* Deferred.make<void>()
      const finishRelease = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(finishRelease, undefined))
      let hold = true
      const publish = bus.publish
      const pauseAfterCommit: Bus.Interface["publish"] = (definition, data, options) => publish(definition, data, options).pipe(Effect.tap((event) => {
        if (!hold || event.type !== SessionEvent.Execution.Succeeded.type || event.durable?.aggregateID !== first.childSessionID) return Effect.void
        hold = false
        return Deferred.succeed(finishing, undefined).pipe(Effect.andThen(Deferred.await(finishRelease)))
      }))
      const publication = spyOn(bus, "publish").mockImplementation(pauseAfterCommit)
      yield* Effect.addFinalizer(() => Effect.sync(() => publication.mockRestore()))
      const gate = yield* llm.gate()
      yield* Effect.addFinalizer(() => gate.release)
      const started = yield* host.experimental.subagent.start({ admissionID: first.admissionID, prompt: { text: "first" }, delivery: "queue", mode: "background", completion: "none" }).pipe(Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.fail(new Error("Initial native start did not return")) }))
      yield* gate.started.pipe(Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.fail(new Error("Initial child did not reach the model gate")) }))
      yield* gate.release
      yield* Deferred.await(finishing).pipe(Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.fail(new Error("Child did not reach durable final settlement")) }))
      const second = yield* host.experimental.subagent.prepare({ ...input, admissionID: "second", target: { kind: "existing", sessionID: first.childSessionID } }).pipe(Effect.timeout("2 seconds"))
      const steeringGate = yield* llm.gate()
      yield* Effect.addFinalizer(() => steeringGate.release)
      const steered = yield* host.experimental.subagent.start({ admissionID: second.admissionID, promptID: SessionMessage.ID.create(), prompt: { text: "steer" }, delivery: "steer", mode: "background", completion: "none" }).pipe(Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.fail(new Error("Steering admission did not return")) }))
      expect(steered.run).toEqual(started.run)
      yield* Deferred.succeed(finishRelease, undefined)
      if (started.run === undefined) throw new Error("Native start omitted its run reference")
      yield* steeringGate.started.pipe(Effect.timeout("2 seconds"))
      expect((yield* host.experimental.subagent.wait({ run: started.run, timeout: 0 })).timedOut).toBe(true)
      yield* steeringGate.release
      const completed = yield* host.experimental.subagent.wait({ run: started.run }).pipe(Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.fail(new Error("Joined generation did not complete")) }))
      expect(completed.receipt.status).toBe("completed")
      expect((yield* sessions.context(parent.id)).filter((message) => message.type === "synthetic")).toEqual([])
      const third = yield* host.experimental.subagent.prepare({ ...input, admissionID: "third", target: { kind: "existing", sessionID: first.childSessionID } })
      const admissions = yield* SubagentAdmissionStore.Service
      const entry = yield* admissions.get("lifetime-owner", third.admissionID)
      if (entry === undefined || third.promptID === undefined) throw new Error("Prepared admission was not durable")
      const recoveredRun = { childSessionID: third.childSessionID, generation: "recovered-successor" }
      yield* admissions.put({ ...entry, status: "accepted", generation: recoveredRun.generation, start: {
        promptID: third.promptID, prompt: { text: "successor" }, delivery: "queue", mode: "background", completion: "none",
      } })
      const restart = yield* SessionRestart.Service
      yield* restart.resumeSuspendedSessions
      const execution = yield* SessionExecution.Service
      expect(yield* execution.isActive(third.childSessionID)).toBe(false)
      const nextGate = yield* llm.gate()
      yield* Effect.addFinalizer(() => nextGate.release)
      const replay = yield* host.experimental.subagent.start({ admissionID: third.admissionID, prompt: { text: "ignored replay" }, delivery: "queue", mode: "background", completion: "none" })
      expect(replay.status).toBe("accepted")
      const successor = yield* host.experimental.subagent.ready({ run: recoveredRun })
      yield* nextGate.started.pipe(Effect.timeout("2 seconds"))
      expect(successor.run?.generation).not.toBe(started.run.generation)
      yield* host.experimental.subagent.cancel({ run: started.run })
      expect((yield* host.experimental.subagent.get({ admissionID: third.admissionID }))?.status).toBe("running")
      yield* nextGate.release
      if (successor.run === undefined) throw new Error("Native successor omitted its run reference")
      expect((yield* host.experimental.subagent.wait({ run: successor.run }).pipe(Effect.timeout("2 seconds"))).receipt.status).toBe("completed")
      expect(approvals).toBe(3)
    }),
  )

  it.live("anchors primary team members to an authentic provisioning tool and revokes later authority", () =>
    Effect.gen(function* () {
      const { sessions, host, input, bus, parent, invokingMessageID } = yield* admissionFixture
      let approvals = 0
      yield* bus.listen((event) => {
        if (event.type !== Permission.Event.Asked.type) return Effect.void
        const request = Schema.decodeUnknownSync(Schema.toType(Permission.Request))(event.data)
        if (request.sessionID !== parent.id) return Effect.void
        approvals++
        return host.permission.reply({ requestID: request.id, reply: "once" }).pipe(Effect.orDie)
      })
      yield* bus.publish(SessionEvent.Tool.Input.Started, { sessionID: parent.id, assistantMessageID: invokingMessageID, id: "team-add-call", name: "team_add_member" })
      const build = Agent.ID.make("build")
      yield* sessions.setPermissions({ sessionID: parent.id, permissions: [{ action: "subagent", resource: "build", effect: "ask" }] })
      const team = { teamRunID: "run", member: "worker" }
      const member = { ...input, agent: build }
      const anchorInvocation = { kind: "tool" as const, agent: build, messageID: invokingMessageID, toolCallID: "team-add-call", team }

      expect((yield* host.experimental.subagent.prepare({ ...member, admissionID: "plain-primary", target: { kind: "create" } }).pipe(Effect.result))._tag).toBe("Failure")
      expect((yield* host.experimental.subagent.prepare({ ...member, admissionID: "forged-anchor", invocation: { ...anchorInvocation, toolCallID: "native-admission-call" }, target: { kind: "create" } }).pipe(Effect.result))._tag).toBe("Failure")
      const anchor = yield* host.experimental.subagent.prepare({ ...member, admissionID: "anchor", invocation: anchorInvocation, target: { kind: "create" } }).pipe(Effect.timeout("2 seconds"))
      expect(anchor.status).toBe("prepared")
      expect(approvals).toBe(1)
      expect((yield* host.experimental.subagent.start({ admissionID: anchor.admissionID, prompt: { text: "provision" }, delivery: "queue", mode: "background", completion: "parent" }).pipe(Effect.result))._tag).toBe("Failure")
      const provisioned = yield* host.experimental.subagent.start({ admissionID: anchor.admissionID, prompt: { text: "provision" }, delivery: "queue", mode: "foreground", completion: "none" }).pipe(Effect.timeout("2 seconds"))
      expect(provisioned.status).toBe("completed")

      // Like OMO's resume, later generations pass the child's projected model, whose omitted variant reads as "default".
      const resumed = (yield* sessions.get(anchor.childSessionID)).model
      if (resumed === undefined) throw new Error("Provisioned child has no model")
      expect(resumed.variant).toBe(Model.VariantID.make("default"))
      const mailbox = (id: string, overrides: { readonly member?: string; readonly variant?: string } = {}) => host.experimental.subagent.prepare({
        ...member,
        model: overrides.variant === undefined ? resumed : { ...resumed, variant: Model.VariantID.make(overrides.variant) },
        admissionID: id,
        invocation: { kind: "team", agent: build, invocationID: id, teamRunID: team.teamRunID, member: overrides.member ?? team.member, provisioningAdmissionID: anchor.admissionID },
        target: { kind: "existing", sessionID: anchor.childSessionID },
      })
      expect((yield* mailbox("mail-1").pipe(Effect.timeout("2 seconds"))).status).toBe("prepared")
      expect((yield* mailbox("mail-other", { member: "other" }).pipe(Effect.result))._tag).toBe("Failure")
      expect(yield* mailbox("mail-variant", { variant: "missing" }).pipe(Effect.flip, Effect.map((error) => (error as { reason?: string }).reason)))
        .toBe("Unavailable subagent model or variant")
      expect(approvals).toBe(1)

      const revoked = yield* host.experimental.subagent.cancel({ admissionID: anchor.admissionID })
      expect(revoked).toEqual({ ...provisioned, revoked: true })
      expect(yield* host.experimental.subagent.cancel({ admissionID: anchor.admissionID })).toEqual(revoked)
      expect((yield* host.experimental.subagent.get({ admissionID: "mail-1" }))?.status).toBe("cancelled")
      // The default variant passes availability, so the revoked anchor itself is what rejects.
      expect(yield* mailbox("mail-2").pipe(Effect.flip, Effect.map((error) => (error as { reason?: string }).reason)))
        .toBe("Provisioning anchor revoked")
    }),
  )

  it.live("accepts a delegated skill batch atomically before start and reuses it without a second ask", () =>
    Effect.gen(function* () {
      const { sessions, host, input, bus, parent } = yield* admissionFixture
      let approvals = 0
      yield* bus.listen((event) => {
        if (event.type !== Permission.Event.Asked.type) return Effect.void
        const request = Schema.decodeUnknownSync(Schema.toType(Permission.Request))(event.data)
        if (request.sessionID !== parent.id) return Effect.void
        approvals++
        return host.permission.reply({ requestID: request.id, reply: "once" }).pipe(Effect.orDie)
      })
      yield* sessions.setPermissions({ sessionID: parent.id, permissions: [{ action: "skill", resource: "review-guide", effect: "ask" }] })
      const skill = Skill.ID.make("review-guide")

      const partial = yield* host.experimental.subagent.prepare({ ...input, admissionID: "partial", target: { kind: "create" } })
      expect((yield* host.experimental.subagent.acceptSkills({ admissionID: partial.admissionID, skills: [{ skill, arguments: "a" }, { skill: Skill.ID.make("missing") }] }).pipe(Effect.result))._tag).toBe("Failure")
      expect(yield* sessions.skillActivations({ sessionID: partial.childSessionID })).toEqual([])
      expect((yield* host.experimental.subagent.start({ admissionID: partial.admissionID, prompt: { text: "partial" }, delivery: "queue", mode: "background", completion: "none" }).pipe(Effect.result))._tag).toBe("Failure")

      const prepared = yield* host.experimental.subagent.prepare({ ...input, admissionID: "skilled", target: { kind: "create" } })
      if (prepared.promptID === undefined) throw new Error("Prepared receipt omitted its prompt ID")
      const batch = [{ skill, arguments: "a" }, { skill, arguments: "b" }]
      const accepted = yield* host.experimental.subagent.acceptSkills({ admissionID: prepared.admissionID, skills: batch }).pipe(Effect.timeout("2 seconds"))
      expect(accepted.map((activation) => [activation.sessionID, activation.skill.id, activation.arguments, activation.source])).toEqual([
        [prepared.childSessionID, skill, "a", { kind: "prompt", messageID: prepared.promptID, selectionIndex: 0 }],
        [prepared.childSessionID, skill, "b", { kind: "prompt", messageID: prepared.promptID, selectionIndex: 1 }],
      ])
      expect(yield* host.experimental.subagent.acceptSkills({ admissionID: prepared.admissionID, skills: batch })).toEqual(accepted)
      expect((yield* host.experimental.subagent.acceptSkills({ admissionID: prepared.admissionID, skills: batch.slice(0, 1) }).pipe(Effect.result))._tag).toBe("Failure")
      const asked = approvals

      expect((yield* host.experimental.subagent.start({ admissionID: prepared.admissionID, prompt: { text: "review", skills: [{ id: skill, arguments: "b" }, { id: skill, arguments: "a" }] }, delivery: "queue", mode: "background", completion: "none" }).pipe(Effect.result))._tag).toBe("Failure")
      const started = yield* host.experimental.subagent.start({ admissionID: prepared.admissionID, prompt: { text: "review", skills: batch.map((item) => ({ id: item.skill, arguments: item.arguments })) }, delivery: "queue", mode: "foreground", completion: "none" }).pipe(Effect.timeout("2 seconds"))
      expect(started.status).toBe("completed")
      expect(approvals).toBe(asked)
      expect(yield* sessions.skillActivations({ sessionID: prepared.childSessionID })).toEqual(accepted)
    }),
  )

})
