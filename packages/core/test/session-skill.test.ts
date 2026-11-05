import type { FileSystem } from "@opencode/core/filesystem"
import path from "path"
import { describe, expect } from "bun:test"
import { Duration, Effect, Layer, LayerMap } from "effect"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Image } from "@opencode/core/image"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import type { LocationServices } from "@opencode/core/location-services"
import { Project } from "@opencode/core/project"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Permission } from "@opencode/core/permission"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { SessionInbox } from "@opencode/core/session/inbox"
import { Skill } from "@opencode/core/skill"
import { Event } from "@opencode/schema/event"
import { ActivationID } from "@opencode/schema/skill"
import { Agent } from "@opencode/core/agent"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"
import { organizationPolicy, registerIntegrationPolicy } from "./fixture/policy"

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
// The organization behind this location's Console connection denies the skill.
const blocked = Location.Ref.make({ directory: AbsolutePath.make("/blocked") })
const info = Skill.Info.make({
  id: Skill.ID.make("effect"),
  name: Skill.Name.make("Effect"),
  description: "Effect guidance",
  path: AbsolutePath.make(path.resolve("/skills/effect.md")),
  content: "  Use Effect\n",
})
const locations = makeGlobalNode({
  service: LocationServiceMap.Service,
  layer: Layer.effect(
    LocationServiceMap.Service,
    LayerMap.make(
      (ref: Location.Ref) =>
        // These tests need skill activation and prompt preparation from the same location services.
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        Layer.mergeAll(
          Layer.effectDiscard(
            Effect.gen(function* () {
              const agents = yield* Agent.Service
              const skills = yield* Skill.Service
              yield* agents.transform((editor) => {
                editor.update(Agent.defaultID, (agent) => {
                  agent.permissions.push({ action: "skill", resource: "effect", effect: "allow" })
                })
              })
              yield* skills.transform((editor) => editor.add(info))
              yield* registerIntegrationPolicy({ skill: skills })
            }),
          ).pipe(
            Layer.provideMerge(
              LayerNode.compile(
                LayerNode.group([
                  Agent.node,
                  PluginHooks.node,
                  Image.node,
                  Permission.node,
                  Skill.node,
                  Config.node,
                  FSUtil.node,
                ]),
                {
                  replacements: [
                    Location.node.replace(Location.boundNode(ref)),
                    Config.node.replace(
                      Config.testLayer(
                        ref.directory === blocked.directory
                          ? [
                              organizationPolicy([
                                { action: "skill.use", resource: "effect", effect: "deny" },
                              ]),
                            ]
                          : [
                              organizationPolicy([
                                { action: "skill.use", resource: "effect", effect: "allow" },
                              ]),
                            ],
                      ),
                    ),
                  ],
                },
              ),
            ),
          ),
          Layer.mock(Plugin.Service, { awaitActivation: Effect.void }),
        ) as unknown as Layer.Layer<LocationServices, FileSystem.DirectoryNotFoundError>,
      { idleTimeToLive: Duration.infinity },
    ),
  ),
  deps: [],
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
      LocationServiceMap.node,
    ]),
    [
      LocationServiceMap.node.replace(locations),
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)

describe("Session.skill", () => {
  it.effect("refuses blocked skill mentions and standalone activation without writing their content", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ location: blocked })
      expect(
        yield* sessions.skill({ sessionID: session.id, skill: info.id, resume: false }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "Session.SkillNotFoundError", skill: info.id })
      expect(
        yield* sessions
          .prompt({
            sessionID: session.id,
            text: "@effect",
            skills: [{ id: info.id, mention: { start: 0, end: 7, text: "@effect" } }],
            resume: false,
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "Session.SkillNotFoundError", skill: info.id })
      expect(yield* sessions.messages({ sessionID: session.id })).toEqual([])
      expect(yield* sessions.inbox(session.id)).toEqual([])
    }),
  )

  it.effect("materializes mentioned skills on their owning prompt", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const session = yield* sessions.create({ location })
      const id = SessionMessage.ID.make("msg_skill_attachment")

      yield* sessions.prompt({
        id,
        sessionID: session.id,
        text: "Apply @effect and @effect",
        skills: [
          { id: Skill.ID.make("effect"), mention: { start: 6, end: 13, text: "@effect" } },
          { id: Skill.ID.make("effect"), mention: { start: 18, end: 25, text: "@effect" } },
        ],
        resume: false,
      })
      expect(yield* sessions.messages({ sessionID: session.id })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "skill",
            source: { kind: "prompt", messageID: id, selectionIndex: 0 },
          }),
          expect.objectContaining({
            type: "skill",
            source: { kind: "prompt", messageID: id, selectionIndex: 1 },
          }),
        ]),
      )
      yield* SessionInbox.promote(database.db, bus, session.id, "steer")

      expect((yield* sessions.messages({ sessionID: session.id })).filter((message) => message.type === "user")).toEqual(
        [
          expect.objectContaining({
            id,
            type: "user",
            text: "Apply @effect and @effect",
            skills: [
              {
                id: "effect",
                name: "Effect",
                text: Skill.toModelOutput(info, []),
                mention: { start: 6, end: 13, text: "@effect" },
              },
              {
                id: "effect",
                name: "Effect",
                mention: { start: 18, end: 25, text: "@effect" },
              },
            ],
          }),
        ],
      )
    }),
  )

  it.effect("excludes mentioned skills when forking before their prompt", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const session = yield* sessions.create({ location })
      const initial = SessionMessage.ID.make("msg_before_skill_attachment")
      const selected = SessionMessage.ID.make("msg_fork_skill_attachment")

      yield* sessions.prompt({ id: initial, sessionID: session.id, text: "Before the skill", resume: false })
      yield* SessionInbox.promote(database.db, bus, session.id, "steer")
      yield* sessions.prompt({
        id: selected,
        sessionID: session.id,
        text: "Apply @effect",
        skills: [{ id: info.id, mention: { start: 6, end: 13, text: "@effect" } }],
        resume: false,
      })
      yield* SessionInbox.promote(database.db, bus, session.id, "steer")
      const forked = yield* sessions.fork({ sessionID: session.id, before: selected })

      expect(yield* sessions.messages({ sessionID: forked.id })).toEqual([
        expect.objectContaining({ type: "user", text: "Before the skill" }),
      ])
    }),
  )

  it.effect("publishes raw standalone content under the caller-supplied ID without inbox admission", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const session = yield* sessions.create({ location })
      const id = SessionMessage.ID.make("msg_caller_skill")
      const activationID = ActivationID.make("ska_caller_skill")
      const locations = yield* LocationServiceMap.Service
      yield* Skill.Service.use((skills) => skills.list()).pipe(Effect.provide(locations.get(session.location)))
      const events: Event.Payload[] = []
      yield* bus.listen((event) =>
        Effect.sync(() => {
          events.push(event)
        }),
      )

      const accepted = yield* sessions.skill({
        activationID,
        messageID: id,
        sessionID: session.id,
        skill: Skill.ID.make("effect"),
        resume: false,
      })

      expect(events).toEqual([
        expect.objectContaining({
          id: "evt_caller_skill",
          type: SessionEvent.Skill.Activated.type,
          data: accepted,
        }),
      ])
      expect(yield* sessions.messages({ sessionID: session.id })).toEqual([
        expect.objectContaining({ id, type: "skill", skill: "effect", name: "Effect", text: accepted.content }),
      ])
      expect(yield* sessions.inbox(session.id)).toEqual([])
    }),
  )

  it.effect("keeps authorized activation identity when a hook replaces readonly fields", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const locations = yield* LocationServiceMap.Service
      const session = yield* sessions.create({ location })
      const redirectedSession = yield* sessions.create({ location })
      const messageID = SessionMessage.ID.make("msg_skill_identity")
      const activationID = ActivationID.make("ska_skill_identity")
      const redirected = Skill.Info.make({
        id: Skill.ID.make("redirected"),
        name: Skill.Name.make("Redirected"),
        description: "Unauthorized guidance",
        path: AbsolutePath.make(path.resolve("/skills/redirected.md")),
        content: "Use redirected guidance",
      })

      yield* PluginHooks.Service.use((hooks) =>
        hooks.register("skill", "experimental.activate", (event) =>
          Effect.sync(() => {
            Object.assign(event.source, { messageID: SessionMessage.ID.make("msg_replaced_source") })
            Object.assign(event, {
              activationID: ActivationID.make("ska_replaced"),
              sessionID: redirectedSession.id,
              agent: Agent.ID.make("redirected"),
              source: { kind: "session", messageID: SessionMessage.ID.make("msg_replaced") },
              skill: redirected,
              arguments: "replaced",
            })
          }),
        ),
      ).pipe(Effect.provide(locations.get(session.location)))

      const accepted = yield* sessions.skill({
        sessionID: session.id,
        activationID,
        messageID,
        skill: info.id,
        arguments: "original",
        resume: false,
      })

      expect(accepted).toMatchObject({
        activationID,
        sessionID: session.id,
        agent: Agent.defaultID,
        source: { kind: "session", messageID },
        skill: { id: info.id, name: info.name },
        arguments: "original",
      })
      expect(yield* sessions.skillActivation({ sessionID: session.id, skillID: info.id })).toEqual(accepted)
      expect(
        yield* sessions.skillActivation({ sessionID: session.id, skillID: redirected.id }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "SessionSkill.NotAccepted", skill: redirected.id })
      expect(yield* sessions.skillActivations({ sessionID: redirectedSession.id })).toEqual([])
    }),
  )

  it.effect("keeps an empty-reason activation denial when a later hook allows", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const locations = yield* LocationServiceMap.Service
      // A separate Location keeps these hooks away from the other activation tests.
      const session = yield* sessions.create({
        location: Location.Ref.make({ directory: AbsolutePath.make("/denial") }),
      })
      yield* PluginHooks.Service.use((hooks) =>
        Effect.all([
          hooks.register("skill", "experimental.activate", (event) =>
            Effect.sync(() => {
              event.decision = { allow: false, reason: "" }
            }),
          ),
          hooks.register("skill", "experimental.activate", (event) =>
            Effect.sync(() => {
              event.decision = { allow: true }
            }),
          ),
        ]),
      ).pipe(Effect.provide(locations.get(session.location)))

      const denied = yield* sessions
        .skill({ sessionID: session.id, skill: info.id, resume: false })
        .pipe(Effect.flip)

      expect(denied).toMatchObject({ _tag: "SessionSkill.ActivationDenied", skill: info.id, reason: "" })
      expect(yield* sessions.messages({ sessionID: session.id })).toEqual([])
    }),
  )

  it.effect("accepts a delegated skill batch as one unit and replays the first snapshots", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ location })
      const child = yield* sessions.create({ parentID: parent.id })
      const promptID = SessionMessage.ID.make("msg_delegated_skills")
      const authorization = { session: parent, agent: Agent.defaultID }
      const items = [
        { activationID: ActivationID.make("ska_delegated_0"), skill: info.id, arguments: "first" },
        { activationID: ActivationID.make("ska_delegated_1"), skill: info.id, arguments: "second" },
      ]

      const missing = yield* sessions
        .acceptSkills({
          sessionID: child.id,
          promptID,
          authorization,
          items: [items[0]!, { ...items[1]!, skill: Skill.ID.make("missing") }],
        })
        .pipe(Effect.flip)
      expect(missing).toMatchObject({ _tag: "Session.SkillNotFoundError" })
      expect(yield* sessions.messages({ sessionID: child.id })).toEqual([])

      const accepted = yield* sessions.acceptSkills({ sessionID: child.id, promptID, authorization, items })
      const replayed = yield* sessions.acceptSkills({ sessionID: child.id, promptID, authorization, items })
      const changed = yield* sessions
        .acceptSkills({ sessionID: child.id, promptID, authorization, items: [items[0]!, { ...items[1]!, arguments: "x" }] })
        .pipe(Effect.flip)

      expect(accepted).toMatchObject([
        { sessionID: child.id, arguments: "first", source: { kind: "prompt", messageID: promptID, selectionIndex: 0 } },
        { sessionID: child.id, arguments: "second", source: { kind: "prompt", messageID: promptID, selectionIndex: 1 } },
      ])
      expect(replayed).toEqual(accepted)
      expect(changed).toMatchObject({ _tag: "SessionSkill.ActivationConflict" })
      expect(yield* sessions.skillActivations({ sessionID: child.id })).toEqual(accepted)

      yield* sessions.prompt({
        id: promptID,
        sessionID: child.id,
        text: "Delegated",
        skills: [
          { id: info.id, arguments: "first" },
          { id: info.id, arguments: "second" },
        ],
        acceptedSkillActivations: items.map((item) => item.activationID),
        resume: false,
      })
      expect(yield* sessions.skillActivations({ sessionID: child.id })).toEqual(accepted)
      expect(yield* sessions.inbox(child.id)).toMatchObject([{ id: promptID, type: "user" }])
    }),
  )

  it.effect("keeps the child's explicit skill denial under parent authorization", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ location })
      const child = yield* sessions.create({
        parentID: parent.id,
        permissions: [{ action: "skill", resource: "effect", effect: "deny" }],
      })

      const denied = yield* sessions
        .acceptSkills({
          sessionID: child.id,
          promptID: SessionMessage.ID.make("msg_delegated_denied"),
          authorization: { session: parent, agent: Agent.defaultID },
          items: [{ activationID: ActivationID.make("ska_delegated_denied"), skill: info.id }],
        })
        .pipe(Effect.flip)

      expect(denied).toMatchObject({ _tag: "Permission.BlockedError", permission: "skill" })
      expect(yield* sessions.messages({ sessionID: child.id })).toEqual([])
    }),
  )
})
