import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Fiber } from "effect"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Project } from "@opencode/schema/project"
import { LayerNode } from "@opencode/util/effect/layer-node"
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
import { tempGlobalLayer } from "./fixture/global"
import { testEffect } from "./lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, SessionInbox.node]),
    { replacements: [Bus.node.replace(Bus.configured({ persist: true })), Global.node.replace(tempGlobalLayer)] },
  ),
)
const senderID = SessionSchema.ID.make("ses_handoff_sender")
const targetID = SessionSchema.ID.make("ses_handoff_target")
const messageID = SessionMessage.ID.make("msg_handoff_call")
const agent = Agent.ID.make("build")
const source = Location.Ref.make({ directory: AbsolutePath.make("/handoff-project") })

const setup = Effect.fnUntraced(function* (options?: {
  readonly execution?: SessionExecution.Interface
  readonly store?: (real: SessionStore.Interface) => SessionStore.Interface
}) {
  const database = yield* Database.Service
  const bus = yield* Bus.Service
  const store = yield* SessionStore.Service
  yield* database.db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: source.directory, sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* Effect.forEach([senderID, targetID], (sessionID) =>
    bus.publish(SessionEvent.Created, {
      sessionID,
      projectID: Project.ID.global,
      location: source,
      slug: "handoff",
      version: "test",
      agent,
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
      ...source,
      project: { id: Project.ID.global, directory: source.directory, canonical: source.directory },
    }),
    sender: { sessionID: senderID, agent, messageID, callID: "call" },
    target: { sessionID: targetID, projectID: Project.ID.global, location: source, agent },
    text: "Repair the reviewed behavior",
    commit: true,
  }
  return { send, input, store, bus, db: database.db, wakes }
})

it.live("inspects without admission, then durably queues one approved peer message before waking", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    expect((yield* f.send({ ...f.input, commit: false })).status).toBe("approval-required")
    expect(yield* SessionInbox.list(f.db, targetID)).toEqual([])
    expect(f.wakes).toEqual([])
    const receipt = yield* f.send(f.input)
    expect(receipt).toMatchObject({ sessionID: targetID, status: "admitted", duplicate: false, wakeScheduled: true })
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
            projectID: Project.ID.global,
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

it.live("rejects a project change after approval without admitting the queued handoff", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    yield* f.send({ ...f.input, commit: false })
    const other = Project.ID.make("other")
    yield* f.db
      .insert(ProjectTable)
      .values({ id: other, worktree: AbsolutePath.make("/other"), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* f.db
      .update(SessionTable)
      .set({ project_id: other })
      .where(eq(SessionTable.id, targetID))
      .run()
      .pipe(Effect.orDie)
    expect(yield* f.send(f.input).pipe(Effect.flip)).toBeInstanceOf(SessionHandoff.Conflict)
    expect(yield* SessionInbox.list(f.db, targetID)).toEqual([])
    expect(f.wakes).toEqual([])
  }),
)

it.live(
  "rolls back at the admission transaction when the target leaves the project between inspection and the atomic commit check",
  () =>
    Effect.gen(function* () {
      let targetReads = 0
      const f = yield* setup({
        store: (real) =>
          SessionStore.Service.of({
            ...real,
            get: (sessionID) =>
              sessionID !== targetID
                ? real.get(sessionID)
                : real
                    .get(sessionID)
                    .pipe(
                      Effect.map((session) =>
                        session === undefined
                          ? undefined
                          : ++targetReads >= 2
                            ? { ...session, projectID: Project.ID.make("other") }
                            : session,
                      ),
                    ),
          }),
      })
      expect(yield* f.send(f.input).pipe(Effect.flip)).toBeInstanceOf(SessionHandoff.Conflict)
      expect(targetReads).toBeGreaterThanOrEqual(2)
      expect((yield* f.store.get(targetID))?.projectID).toBe(Project.ID.global)
      expect(yield* SessionInbox.list(f.db, targetID)).toEqual([])
      expect(f.wakes).toEqual([])
    }),
)
