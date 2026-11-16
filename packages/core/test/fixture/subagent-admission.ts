import { Effect, Layer } from "effect"
import { LanguageModel } from "@opencode/ai/effect"
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
import { SubagentAdmissionStore } from "@opencode/core/session/subagent-admission-store"
import { SubagentJob } from "@opencode/core/session/subagent-job"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionEvent } from "@opencode/core/session/event"
import { Bus } from "@opencode/core/bus"
import { SessionRestart } from "@opencode/core/session/execution/restart"
import { SessionExecution } from "@opencode/core/session/execution"
import { KV } from "@opencode/core/kv"
import { Instance } from "@opencode/core/instance/service"
import { Database } from "@opencode/core/database/database"
import { SessionStore } from "@opencode/core/session/store"
import { Provider } from "@opencode/core/provider"
import { Permission } from "@opencode/core/permission"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "./global"
import { offlineModels } from "./models"
import { tmpdirScoped } from "./tmpdir"
import { testEffect } from "../lib/effect"

const llmLayer = TestLLM.testLayer({ fallback: TestLLM.text("Review complete", "review") })
export const admissionTests = testEffect(
  Layer.merge(llmLayer, AppNodeBuilder.build(LayerNode.group([
    Session.node, Job.node, Bus.node, Database.node, KV.node, SessionStore.node, SessionInbox.node,
    Instance.node, LocationServiceMap.node, SubagentAdmissionStore.node, SubagentJob.node, SessionRestart.node, SessionExecution.node,
  ]), [
    Global.node.replace(tempGlobalLayer),
    offlineModels,
    Watcher.node.replace(Watcher.configured({ enabled: false })),
    LayerNodePlatform.llmClient.replace(llmLayer),
    SessionRunnerModel.node.replace(Layer.succeed(SessionRunnerModel.Service, {
      resolve: () => Effect.succeed(SessionRunnerModel.resolved(
        LanguageModel.make({ id: "review", provider: "test", route: OpenAIChat.route }),
        { capabilities: { tools: true, input: ["text"], output: ["text"] }, cost: [], limit: { context: 200_000, output: 32_000 } },
      )),
    })),
  ])),
)

export const admissionFixture = Effect.gen(function* () {
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
      steer: (input) => runs.steer("lifetime-owner", input),
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

export const runningAdmission = Effect.gen(function* () {
  const fixture = yield* admissionFixture
  const { sessions, host, input, bus, parent, llm, invokingMessageID } = fixture
  yield* sessions.setPermissions({ sessionID: parent.id, permissions: [{ action: "subagent", resource: "reviewer", effect: "allow" }] })
  yield* bus.publish(SessionEvent.Tool.Input.Started, { sessionID: parent.id, assistantMessageID: invokingMessageID, id: "clarify-call", name: "task" })
  const prepared = yield* host.experimental.subagent.prepare({ ...input, admissionID: "original", target: { kind: "create" } })
  const gate = yield* llm.gate()
  const started = yield* host.experimental.subagent.start({ admissionID: prepared.admissionID, prompt: { text: "original work" }, delivery: "queue", mode: "background", completion: "parent" })
  if (!started.run) throw new Error("Native start omitted its run")
  yield* gate.started.pipe(Effect.timeout("2 seconds"))
  const steer = { admissionID: prepared.admissionID, run: started.run, invocation: { ...input.invocation, toolCallID: "clarify-call" }, prompt: { text: "clarification" } }
  return { ...fixture, gate, started, run: started.run, steer }
})
