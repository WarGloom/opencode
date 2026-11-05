import { expect } from "bun:test"
import { Deferred, Effect } from "effect"
import { Agent } from "@opencode/core/agent"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Provider } from "@opencode/core/provider"
import { Model } from "@opencode/core/model"
import { Location } from "@opencode/core/location"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionEvent } from "@opencode/core/session/event"
import { Bus } from "@opencode/core/bus"
import { Job } from "@opencode/core/job"
import { Command } from "@opencode/core/command"
import { SubagentAdmissionStore } from "@opencode/core/session/subagent-admission-store"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

const fixture = Effect.gen(function* () {
  const agents = yield* Agent.Service
  const providers = yield* Provider.Service
  const sessions = yield* Session.Service
  const location = yield* Location.Service
  const plugins = yield* Plugin.Service
  const model = Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("admission") })
  yield* providers.transform((editor) => editor.models.update(model.providerID, model.id, () => {}))
  yield* agents.transform((editor) => {
    editor.update(Agent.ID.make("build"), () => {})
    editor.update(Agent.ID.make("worker"), (agent) => { agent.mode = "subagent" })
  })
  const parent = yield* sessions.create({ location: Location.Ref.make({ directory: location.directory }), agent: Agent.ID.make("build"), model })
  const host = yield* PluginHost.make(plugins, "admission-owner")
  const bus = yield* Bus.Service
  const messageID = SessionMessage.ID.create()
  yield* bus.publish(SessionEvent.Step.Started, { sessionID: parent.id, assistantMessageID: messageID, agent: Agent.ID.make("build"), model, started: 0 })
  yield* bus.publish(SessionEvent.Tool.Input.Started, { sessionID: parent.id, assistantMessageID: messageID, id: "prepare-call", name: "task" })
  const input = {
    admissionID: "prepared-task",
    parentSessionID: parent.id,
    agent: Agent.ID.make("worker"),
    model,
    maxDepth: 3,
    description: "Prepare isolated child",
    invocation: { kind: "tool" as const, agent: Agent.ID.make("build"), messageID, toolCallID: "prepare-call" },
    target: { kind: "create" as const, sessionID: Session.ID.create() },
  }
  return { sessions, host, input, messageID, bus }
})

it.effect("returns the original prepared child on replay without executing model work", () =>
  Effect.gen(function* () {
    const { sessions, host, input } = yield* fixture
    const first = yield* host.experimental.subagent.prepare(input)
    const replay = yield* host.experimental.subagent.prepare(input)
    expect(replay).toEqual(first)
    expect(first.status).toBe("prepared")
    expect(first.childSessionID).toBe(input.target.sessionID)
    expect(yield* sessions.context(first.childSessionID)).toEqual([])
    const execution = yield* SessionExecution.Service
    expect(yield* execution.isActive(first.childSessionID)).toBe(false)
  }),
)

it.effect("does not authorize a changed binding or revive a cancelled preparation", () =>
  Effect.gen(function* () {
    const { host, input } = yield* fixture
    yield* host.experimental.subagent.prepare(input)
    const changed = yield* host.experimental.subagent.prepare({ ...input, maxDepth: 2 }).pipe(Effect.result)
    expect(changed._tag).toBe("Failure")
    yield* host.experimental.subagent.cancel({ admissionID: input.admissionID })
    const replay = yield* host.experimental.subagent.prepare(input)
    expect(replay.status).toBe("cancelled")
    expect((yield* host.experimental.subagent.reconcile()).map((entry) => entry.status)).toEqual(["cancelled"])
  }),
)

it.effect("rejects stale recovered readiness before admitting input to an active successor", () =>
  Effect.gen(function* () {
    const { sessions, host, input } = yield* fixture
    const prepared = yield* host.experimental.subagent.prepare(input)
    const admissions = yield* SubagentAdmissionStore.Service
    const entry = yield* admissions.get("admission-owner", input.admissionID)
    if (entry === undefined || prepared.promptID === undefined) throw new Error("Prepared admission was not durable")
    const oldRun = { childSessionID: prepared.childSessionID, generation: "orphaned-generation" }
    yield* admissions.put({ ...entry, status: "accepted", generation: oldRun.generation, start: {
      promptID: prepared.promptID, prompt: { text: "obsolete work" }, delivery: "queue", mode: "background", completion: "none",
    } })
    const jobs = yield* Job.Service
    const release = yield* Deferred.make<string>()
    yield* Effect.addFinalizer(() => Deferred.succeed(release, "done"))
    yield* jobs.start({ id: prepared.childSessionID, type: "subagent", generation: "successor", run: Deferred.await(release) })
    const bus = yield* Bus.Service
    yield* bus.listen((event) => event.type === SessionEvent.Execution.Started.type && event.durable?.aggregateID === prepared.childSessionID
      ? Deferred.await(release).pipe(Effect.asVoid)
      : Effect.void)
    const result = yield* host.experimental.subagent.ready({ run: oldRun }).pipe(Effect.result)
    expect(result._tag).toBe("Failure")
    expect(yield* sessions.inbox(prepared.childSessionID)).toEqual([])
    expect((yield* jobs.get(prepared.childSessionID))?.generation).toBe("successor")
    yield* Deferred.succeed(release, "done")
  }),
)

it.effect("admits a primary target only for an authenticated command subtask", () =>
  Effect.gen(function* () {
    const { host, input } = yield* fixture
    const commands = yield* Command.Service
    const build = Agent.ID.make("build")
    const primary = { ...input, agent: build, target: { kind: "create" as const } }
    const invocationID = Command.InvocationID.create()
    const invocation = { kind: "command" as const, agent: build, invocationID, command: "review" }

    // A task tool call cannot target a primary agent.
    expect((yield* host.experimental.subagent.prepare({ ...primary, admissionID: "tool-primary" }).pipe(Effect.result))._tag).toBe("Failure")
    // A command subtask without its live invocation is not authenticated.
    expect((yield* host.experimental.subagent.prepare({ ...primary, admissionID: "stale-command", invocation }).pipe(Effect.result))._tag).toBe("Failure")

    const reason = (effect: Effect.Effect<unknown, unknown>) =>
      effect.pipe(Effect.flip, Effect.map((error) => (error as { reason?: string }).reason))
    const live = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      commands.withInvocation({ invocationID, sessionID: input.parentSessionID, command: "review", agent: build }, effect)

    // A live command invocation still cannot pick a primary other than the parent's agent.
    yield* (yield* Agent.Service).transform((editor) => editor.update(Agent.ID.make("lead"), (agent) => { agent.mode = "primary" }))
    expect(yield* live(reason(host.experimental.subagent.prepare({ ...primary, agent: Agent.ID.make("lead"), admissionID: "other-primary", invocation }))))
      .toBe("Command primary target must be the parent agent")

    const prepared = yield* live(host.experimental.subagent.prepare({ ...primary, admissionID: "command-primary", invocation }))
    expect(prepared.status).toBe("prepared")
  }),
)
