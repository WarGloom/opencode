import { describe, expect, spyOn } from "bun:test"
import { Context, Deferred, Effect, Exit, Layer, Scope } from "effect"
import { LanguageModel } from "@opencode/ai/effect"
import { LLMClient } from "@opencode/ai/route"
import { OpenAIChat } from "@opencode/ai/protocols"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Job } from "@opencode/core/job"
import { KV } from "@opencode/core/kv"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SubagentAdmissionRun } from "@opencode/core/session/subagent-admission-run"
import { SubagentAdmissionStore } from "@opencode/core/session/subagent-admission-store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { admissionFixture, admissionTests } from "./fixture/subagent-admission"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"

describe("subagent steer restart", () => {
  for (const replay of [false, true]) {
    admissionTests.live(`restores unread prompt ownership before settlement ${replay ? "with" : "without"} caller replay`, () => Effect.gen(function* () {
      const { sessions, host, input, parent, llm, bus } = yield* admissionFixture
      yield* sessions.setPermissions({ sessionID: parent.id, permissions: [{ action: "subagent", resource: "reviewer", effect: "allow" }] })
      const prepared = yield* host.experimental.subagent.prepare({ ...input, admissionID: "restart-steer", target: { kind: "create" } })
      const admissions = yield* SubagentAdmissionStore.Service
      const ownership = AppNodeBuilder.build(LayerNode.group([Session.node, Job.node, SessionExecution.node, LocationServiceMap.node]), [
        Database.node.replace(Layer.succeed(Database.Service, yield* Database.Service)),
        Bus.node.replace(Layer.succeed(Bus.Service, bus)),
        SessionProjector.node.replace(Layer.empty),
        KV.node.replace(Layer.succeed(KV.Service, yield* KV.Service)),
        SubagentAdmissionStore.node.replace(Layer.succeed(SubagentAdmissionStore.Service, admissions)),
        Global.node.replace(tempGlobalLayer), offlineModels,
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
      const gate = yield* llm.gate()
      const started = yield* originalRuns.start("lifetime-owner", { admissionID: prepared.admissionID, prompt: { text: "original" }, delivery: "queue", mode: "background", completion: "parent" })
      if (!started.run) throw new Error("Native start omitted its run")
      const run = started.run
      yield* gate.started.pipe(Effect.timeout("2 seconds"))
      const request = { admissionID: prepared.admissionID, run, invocation: { ...input.invocation, toolCallID: "omo-agent-call" }, prompt: { text: "pending across restart" } }
      const admitted = yield* originalRuns.steer("lifetime-owner", request)
      expect(admitted).toMatchObject({ kind: "joined-existing-run", run })
      yield* Scope.close(originalScope, Exit.void)
      const selected = Model.Ref.make({ ...input.model, variant: Model.VariantID.make("high") })
      yield* sessions.switchModel({ sessionID: run.childSessionID, model: selected })
      const restartedScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(restartedScope, Exit.void))
      const restarted = yield* Layer.buildWithScope(Layer.fresh(ownership), restartedScope)
      const restartedLocations = Context.get(restarted, LocationServiceMap.Service)
      yield* Plugin.Service.use((plugins) => plugins.awaitActivation).pipe(Effect.provide(restartedLocations.get(parent.location)))
      const runs = yield* SubagentAdmissionRun.Service.pipe(Effect.provide(restartedLocations.get(parent.location)))
      const execution = Context.get(restarted, SessionExecution.Service)
      const resume = spyOn(execution, "resume").mockImplementation(() => Effect.never)
      const wake = spyOn(execution, "wake").mockImplementation(() => Effect.void)
      yield* Effect.addFinalizer(() => Effect.sync(() => { resume.mockRestore(); wake.mockRestore() }))
      if (replay) expect(yield* runs.steer("lifetime-owner", { ...request, prompt: { text: "ignored retry" } })).toEqual(admitted)
      expect((yield* runs.ready("lifetime-owner", { run })).run).toEqual(run)
      const jobs = Context.get(restarted, Job.Service)
      expect(yield* jobs.get(run.childSessionID)).toMatchObject({ status: "running", generation: run.generation })
      expect((yield* sessions.get(run.childSessionID)).model).toEqual(selected)
      const reported = yield* Deferred.make<void>()
      yield* bus.listen((event) => event.type === SessionEvent.InboxEnqueued.type && event.durable?.aggregateID === parent.id
        ? Deferred.succeed(reported, undefined).pipe(Effect.asVoid) : Effect.void)
      yield* jobs.cancel(run.childSessionID, run.generation)
      const final = yield* runs.wait("lifetime-owner", { run }).pipe(Effect.timeout("2 seconds"))
      expect(final.receipt).toMatchObject({ status: "cancelled", run, error: expect.stringContaining("pending across restart") })
      yield* Deferred.await(reported).pipe(Effect.timeout("2 seconds"))
      expect(yield* sessions.inbox(run.childSessionID)).toEqual([])
      expect((yield* sessions.inbox(parent.id)).filter((item) => item.type === "synthetic")).toHaveLength(1)
    }))
  }
})
