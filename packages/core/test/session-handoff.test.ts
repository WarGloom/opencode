import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Context, Deferred, Effect, Fiber, Layer } from "effect"
import { mkdir } from "node:fs/promises"
import { Agent } from "../src/agent.js"
import { AppNodeBuilder } from "../src/effect/app-node-builder.js"
import { Config } from "../src/config.js"
import { Instance } from "../src/instance/service.js"
import { InstructionDiscovery } from "../src/instruction-discovery.js"
import { ModelsDev } from "../src/models-dev.js"
import { Permission } from "../src/permission.js"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Project } from "@opencode/schema/project"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { WorkspaceID } from "@opencode/schema/workspace-id"
import { AbsolutePath } from "../src/schema.js"
import { Location } from "../src/location.js"
import { Bus } from "../src/bus.js"
import { Database } from "../src/database/database.js"
import { ProjectTable } from "../src/project/sql.js"
import { SessionEvent } from "../src/session/event.js"
import { SessionExecution } from "../src/session/execution.js"
import { SessionHandoff } from "../src/session/handoff.js"
import { SessionInbox } from "../src/session/inbox.js"
import { SessionMessage } from "../src/session/message.js"
import { SessionSchema } from "../src/session/schema.js"
import { SessionTable } from "../src/session/sql.js"
import { SessionStore } from "../src/session/store.js"
import { SessionProjector } from "../src/session/projector.js"
import { SessionRunCoordinator } from "../src/session/run-coordinator.js"
import { SessionRunner } from "../src/session/runner/index.js"
import { SessionRunnerLLM } from "../src/session/runner/llm.js"
import { tempGlobalLayer } from "./fixture/global"
import { testEffect } from "./lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Global.node,
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      SessionInbox.node,
    ]),
    { replacements: [Bus.node.replace(Bus.configured({ persist: true })), Global.node.replace(tempGlobalLayer)] },
  ),
)
const senderID = SessionSchema.ID.make("ses_handoff_sender")
const targetID = SessionSchema.ID.make("ses_handoff_target")
const messageID = SessionMessage.ID.make("msg_handoff_call")
const agent = Agent.ID.make("build")
const targetAgent = Agent.ID.make("review")
const targetProject = Project.ID.make("handoff-target-project")
const source = Location.Ref.make({ directory: AbsolutePath.make("/handoff-project") })
const destination = Location.Ref.make({ directory: AbsolutePath.make("/handoff-target") })

const setup = Effect.fnUntraced(function* (options?: {
  readonly execution?: SessionExecution.Interface
  readonly store?: (real: SessionStore.Interface) => SessionStore.Interface
  readonly location?: { readonly source: Location.Ref; readonly target: Location.Ref }
  readonly crossProject?: boolean
}) {
  const database = yield* Database.Service
  const bus = yield* Bus.Service
  const store = yield* SessionStore.Service
  const senderLocation = options?.location?.source ?? source
  const targetLocation = options?.location?.target ?? destination
  const projectID = options?.crossProject === false ? Project.ID.global : targetProject
  yield* database.db
    .insert(ProjectTable)
    .values([
      { id: Project.ID.global, worktree: senderLocation.directory, sandboxes: [] },
      ...(projectID === Project.ID.global
        ? []
        : [{ id: projectID, worktree: targetLocation.directory, sandboxes: [] }]),
    ])
    .run()
    .pipe(Effect.orDie)
  yield* Effect.forEach([senderID, targetID], (sessionID) =>
    bus.publish(SessionEvent.Created, {
      sessionID,
      projectID: sessionID === senderID ? Project.ID.global : projectID,
      location: sessionID === senderID ? senderLocation : targetLocation,
      slug: "handoff",
      version: "test",
      agent: sessionID === senderID ? agent : targetAgent,
    }),
  )
  yield* bus.publish(SessionEvent.Step.Started, {
    sessionID: senderID,
    assistantMessageID: messageID,
    agent,
    started: 1,
    model: { id: Model.ID.make("unused"), providerID: Provider.ID.make("unused") },
  })
  yield* bus.publish(SessionEvent.Tool.Input.Started, {
    sessionID: senderID,
    assistantMessageID: messageID,
    id: "call",
    name: "session_handoff",
  })
  yield* bus.publish(SessionEvent.Tool.Called, {
    sessionID: senderID,
    assistantMessageID: messageID,
    id: "call",
    executed: true,
    input: { action: "send", sessionID: targetID, text: "Repair the reviewed behavior" },
  })
  const wakes: SessionSchema.ID[] = []
  const handoffMake = options?.store
    ? SessionHandoff.make.pipe(Effect.provideService(SessionStore.Service, options.store(store)))
    : SessionHandoff.make
  const send = yield* handoffMake.pipe(
    Effect.provideService(
      SessionExecution.Service,
      options?.execution ?? {
        ...SessionExecution.noop,
        wake: (id) =>
          Effect.sync(() => {
            wakes.push(id)
          }),
      },
    ),
  )
  const input = {
    pluginID: "omo",
    location: new Location.Info({
      ...senderLocation,
      project: { id: Project.ID.global, directory: senderLocation.directory, canonical: senderLocation.directory },
    }),
    sender: { sessionID: senderID, agent, messageID, callID: "call" },
    target: { sessionID: targetID, projectID, location: targetLocation, agent: targetAgent },
    text: "Repair the reviewed behavior",
    commit: true,
  }
  return { send, input, store, bus, db: database.db, wakes }
})

for (const crossProject of [false, true]) {
  it.live(
    `inspects without admission, then durably queues one approved peer message with crossProject=${crossProject}`,
    () =>
      Effect.gen(function* () {
        const f = yield* setup({ crossProject })
        expect((yield* f.send({ ...f.input, commit: false })).status).toBe("approval-required")
        expect(yield* SessionInbox.list(f.db, targetID)).toEqual([])
        expect(f.wakes).toEqual([])
        const receipt = yield* f.send(f.input)
        expect(receipt).toMatchObject({
          sessionID: targetID,
          status: "admitted",
          duplicate: false,
          wakeScheduled: true,
        })
        const pending = yield* SessionInbox.list(f.db, targetID)
        expect(pending).toHaveLength(1)
        expect(pending[0]).toMatchObject({
          id: receipt.id,
          delivery: "queue",
          type: "synthetic",
          payload: {
            metadata: {
              peerHandoff: {
                senderSessionID: senderID,
                senderAgent: agent,
                senderMessageID: messageID,
                senderCallID: "call",
                targetSessionID: targetID,
                projectID: crossProject ? targetProject : Project.ID.global,
                senderProjectID: Project.ID.global,
                senderDirectory: source.directory,
                targetDirectory: destination.directory,
                targetAgent,
              },
            },
          },
        })
        const item = pending[0]
        if (item?.type !== "synthetic") throw new Error("Expected peer message")
        expect(JSON.parse(item.payload.text.slice(item.payload.text.indexOf("\n") + 1)).message).toBe(f.input.text)
        expect(f.wakes).toEqual([targetID])
      }),
  )
}

it.live("reconciles pending and delivered retries while rejecting changed content and recipient", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const first = yield* f.send(f.input)
    expect(yield* f.send(f.input)).toMatchObject({ id: first.id, status: "admitted", duplicate: true })
    yield* SessionInbox.promote(f.db, f.bus, targetID, "input")
    const before = f.wakes.length
    expect(yield* f.send(f.input)).toMatchObject({
      id: first.id,
      status: "delivered",
      duplicate: true,
      wakeScheduled: false,
    })
    expect(f.wakes).toHaveLength(before)
    expect(yield* f.send({ ...f.input, text: "Substituted repair" }).pipe(Effect.flip)).toBeInstanceOf(
      SessionHandoff.Conflict,
    )
    expect(
      yield* f.send({ ...f.input, target: { ...f.input.target, sessionID: senderID } }).pipe(Effect.flip),
    ).toBeInstanceOf(SessionInbox.LifecycleConflict)
    expect(yield* f.store.messages({ sessionID: targetID, type: "synthetic" })).toHaveLength(1)
  }),
)

for (const boundary of ["project", "host", "self", "missing", "invocation"] as const) {
  it.live(`rejects the ${boundary} boundary without admission or wake`, () =>
    Effect.gen(function* () {
      const f = yield* setup()
      const input = (() => {
        switch (boundary) {
          case "project":
            return { ...f.input, target: { ...f.input.target, projectID: Project.ID.make("other") } }
          case "host":
            return {
              ...f.input,
              location: new Location.Info({ ...f.input.location, workspaceID: WorkspaceID.make("wrk_remote") }),
            }
          case "self":
            return { ...f.input, target: { ...f.input.target, sessionID: senderID } }
          case "missing":
            return { ...f.input, target: { ...f.input.target, sessionID: SessionSchema.ID.make("ses_missing") } }
          case "invocation":
            return { ...f.input, text: "Unapproved replacement" }
          default: {
            const exhaustive: never = boundary
            return exhaustive
          }
        }
      })()
      expect(yield* f.send(input).pipe(Effect.flip)).toBeInstanceOf(SessionHandoff.Conflict)
      expect(yield* SessionInbox.list(f.db, targetID)).toEqual([])
      expect(f.wakes).toEqual([])
    }),
  )
}

for (const busy of [false, true]) {
  it.live(`delivers through the native coordinator with busy=${busy} without interrupting active work`, () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const bus = yield* Bus.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const coordinator = yield* SessionRunCoordinator.make({
        drain: (id: SessionSchema.ID, force, scope) =>
          Effect.gen(function* () {
            if (force) {
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(release)
              expect(yield* SessionInbox.promote(db, bus, id, "steer")).toBe(0)
              return
            }
            yield* SessionInbox.promote(db, bus, id, scope)
          }),
      })
      const f = yield* setup({ execution: { ...SessionExecution.noop, wake: coordinator.wake } })
      const active = busy ? yield* coordinator.run(targetID).pipe(Effect.forkScoped) : undefined
      if (busy) yield* Deferred.await(started)
      const receipt = yield* f.send(f.input)
      if (busy) {
        expect(yield* SessionInbox.list(db, targetID)).toMatchObject([{ id: receipt.id, delivery: "queue" }])
        yield* Deferred.succeed(release, undefined)
      }
      if (active) yield* Fiber.join(active)
      yield* coordinator.awaitIdle(targetID)
      expect((yield* f.store.message(receipt.id))?.message).toMatchObject({ type: "synthetic" })
      expect((yield* f.send({ ...f.input, commit: false })).status).toBe("delivered")
    }),
  )
}

for (const boundary of [
  "project",
  "directory",
  "agent",
  "workspace",
  "parent",
  "archived",
  "sender-project",
  "sender-directory",
  "sender-agent",
] as const) {
  it.live(`rejects a ${boundary} change after approval without admitting the queued handoff`, () =>
    Effect.gen(function* () {
      const f = yield* setup()
      yield* f.send({ ...f.input, commit: false })
      const change = (() => {
        switch (boundary) {
          case "project":
            return { id: targetID, values: { project_id: Project.ID.global } }
          case "directory":
            return { id: targetID, values: { directory: AbsolutePath.make("/moved") } }
          case "agent":
            return { id: targetID, values: { agent } }
          case "workspace":
            return { id: targetID, values: { workspace_id: WorkspaceID.make("wrk_remote") } }
          case "parent":
            return { id: targetID, values: { parent_id: senderID } }
          case "archived":
            return { id: targetID, values: { time_archived: 1 } }
          case "sender-project":
            return { id: senderID, values: { project_id: targetProject } }
          case "sender-directory":
            return { id: senderID, values: { directory: AbsolutePath.make("/moved-sender") } }
          case "sender-agent":
            return { id: senderID, values: { agent: targetAgent } }
          default: {
            const exhaustive: never = boundary
            return exhaustive
          }
        }
      })()
      yield* f.db.update(SessionTable).set(change.values).where(eq(SessionTable.id, change.id)).run().pipe(Effect.orDie)
      expect(yield* f.send(f.input).pipe(Effect.flip)).toBeInstanceOf(SessionHandoff.Conflict)
      expect(yield* SessionInbox.list(f.db, targetID)).toEqual([])
      expect(f.wakes).toEqual([])
    }),
  )
}

for (const boundary of ["project", "directory", "agent", "workspace", "parent", "archived"] as const) {
  it.live(`rolls back the admission transaction when the target changes ${boundary} after the pre-check`, () =>
    Effect.gen(function* () {
      let targetReads = 0
      const f = yield* setup({
        store: (real) =>
          SessionStore.Service.of({
            ...real,
            get: (sessionID) =>
              sessionID !== targetID
                ? real.get(sessionID)
                : real.get(sessionID).pipe(
                    Effect.map((session) => {
                      if (session === undefined || ++targetReads < 2) return session
                      switch (boundary) {
                        case "project":
                          return { ...session, projectID: Project.ID.global }
                        case "directory":
                          return { ...session, location: Location.Ref.make({ directory: AbsolutePath.make("/moved") }) }
                        case "agent":
                          return { ...session, agent }
                        case "workspace":
                          return {
                            ...session,
                            location: Location.Ref.make({
                              ...session.location,
                              workspaceID: WorkspaceID.make("wrk_remote"),
                            }),
                          }
                        case "parent":
                          return { ...session, parentID: senderID }
                        case "archived":
                          return { ...session, time: { ...session.time, archived: session.time.created } }
                        default: {
                          const exhaustive: never = boundary
                          return exhaustive
                        }
                      }
                    }),
                  ),
          }),
      })
      expect(yield* f.send(f.input).pipe(Effect.flip)).toBeInstanceOf(SessionHandoff.Conflict)
      expect(targetReads).toBe(2)
      expect((yield* f.store.get(targetID))?.projectID).toBe(targetProject)
      expect(yield* SessionInbox.list(f.db, targetID)).toEqual([])
      expect(f.wakes).toEqual([])
    }),
  )
}

it.live("native execution promotes the handoff in the recipient Location with its agent permissions", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const inbox = yield* SessionInbox.Service
    const global = yield* Global.Service
    const location = {
      source: Location.Ref.make({ directory: AbsolutePath.make(`${global.tmp}/sender`) }),
      target: Location.Ref.make({ directory: AbsolutePath.make(`${global.tmp}/recipient`) }),
    }
    yield* Effect.promise(() =>
      Promise.all(Object.values(location).map((ref) => mkdir(ref.directory, { recursive: true }))),
    )
    const observed: { directory: string; agent: Agent.ID; shellAllowed: boolean }[] = []
    const runner = Layer.effect(
      SessionRunner.Service,
      Effect.gen(function* () {
        const current = yield* Location.Service
        const agents = yield* Agent.Service
        const permission = yield* Permission.Service
        return SessionRunner.Service.of({
          drain: (input) =>
            Effect.gen(function* () {
              const session = yield* store.get(input.sessionID)
              if (!session) return yield* Effect.die(new Error("Missing native handoff recipient"))
              const selected = yield* agents.select(session.agent)
              if (!selected.info)
                return yield* Effect.die(new Error("Recipient agent is unavailable in the selected Location"))
              const shellAllowed = yield* permission
                .allows({
                  sessionID: session.id,
                  action: "shell",
                  resources: ["*"],
                  source: { type: "tool", messageID, id: "permission-probe" },
                })
                .pipe(Effect.orDie)
              yield* SessionInbox.promote(database.db, bus, session.id, input.promotable ?? "input")
              observed.push({ directory: current.directory, agent: selected.id, shellAllowed })
              return SessionRunner.DrainResult.Complete()
            }),
        })
      }),
    )
    const runtime = yield* Layer.buildWithScope(
      AppNodeBuilder.build(LayerNode.group([Instance.node, SessionExecution.node]), [
        Database.node.replace(Layer.succeed(Database.Service, database)),
        Bus.node.replace(Layer.succeed(Bus.Service, bus)),
        SessionStore.node.replace(Layer.succeed(SessionStore.Service, store)),
        SessionInbox.node.replace(Layer.succeed(SessionInbox.Service, inbox)),
        Global.node.replace(Layer.succeed(Global.Service, global)),
        Config.node.replace(Config.testLayer()),
        ModelsDev.node.replace(ModelsDev.configured({ fetch: false, snapshot: false })),
        InstructionDiscovery.node.replace(InstructionDiscovery.configured({ project: false, global: false })),
        SessionRunnerLLM.node.replace(
          makeLocationNode({
            service: SessionRunner.Service,
            layer: runner,
            deps: [Location.node, Agent.node, Permission.node],
          }),
        ),
      ]),
      yield* Effect.scope,
    )
    const execution = Context.get(runtime, SessionExecution.Service)
    const instances = Context.get(runtime, Instance.Service)
    const f = yield* setup({ execution, location })
    for (const id of [senderID, targetID]) {
      const session = yield* store.get(id)
      if (!session) return yield* Effect.die(new Error("Missing native handoff session"))
      yield* Agent.Service.use((agents) =>
        agents.transform((editor) => {
          editor.update(id === senderID ? agent : targetAgent, (entry) => {
            entry.permissions = [{ action: "shell", resource: "*", effect: id === senderID ? "allow" : "deny" }]
          })
        }),
      ).pipe(instances.provide(session))
      if (id === senderID) {
        const senderAllowed = yield* Permission.Service.use((permission) =>
          permission.allows({
            sessionID: id,
            action: "shell",
            resources: ["*"],
            source: { type: "tool", messageID, id: "sender-permission-probe" },
          }),
        ).pipe(instances.provide(session), Effect.orDie)
        expect(senderAllowed).toBe(true)
      }
    }
    yield* f.send({ ...f.input, commit: false })
    const receipt = yield* f.send(f.input)
    yield* execution.awaitIdle(targetID)
    expect(observed).toEqual([{ directory: location.target.directory, agent: targetAgent, shellAllowed: false }])
    expect((yield* store.message(receipt.id))?.message).toMatchObject({ type: "synthetic" })
    expect(yield* store.messages({ sessionID: senderID, type: "synthetic" })).toEqual([])
    expect(yield* f.send({ ...f.input, commit: false })).toMatchObject({
      status: "delivered",
      duplicate: true,
      wakeScheduled: false,
    })
    console.log(
      JSON.stringify({
        proof: "native-handoff-routing",
        recipientLocation: "recipient",
        agent: targetAgent,
        shellAllowed: observed[0]?.shellAllowed,
        delivered: true,
        providerCalls: 0,
        toolExecutions: 0,
      }),
    )
  }),
)
