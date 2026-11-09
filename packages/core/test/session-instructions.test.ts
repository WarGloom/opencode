import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { DateTime, Effect, Layer } from "effect"
import { LanguageModel, SystemPart } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { Agent } from "@opencode/core/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Image } from "@opencode/core/image"
import { Location } from "@opencode/core/location"
import { FileAccess } from "@opencode/core/file-access"
import { Environment } from "@opencode/core/environment/index"
import { Model } from "@opencode/core/model"
import { Permission } from "@opencode/core/permission"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { ReadTool } from "@opencode/core/tool/plugin/read"
import { ReadToolFileSystem } from "@opencode/core/tool/read-filesystem"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionHistory } from "@opencode/core/session/history"
import { SessionInstructions } from "@opencode/core/session/instructions"
import { InstructionState } from "@opencode/core/session/instruction-state"
import { Instructions } from "@opencode/core/instructions/index"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { Session } from "@opencode/core/session"
import { AbsolutePath } from "@opencode/core/schema"
import { Skill } from "@opencode/core/skill"
import { toLLMMessages } from "@opencode/core/session/runner/to-llm-message"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Tool } from "@opencode/core/tool"
import { tempLocationLayer } from "./fixture/location"
import { promptLocationNode } from "./fixture/prompt-location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { globalProjectNode } from "./lib/project"
import { executeTool, registerToolPlugin } from "./lib/tool"

const readToolNode = makeLocationNode({
  name: "test/read-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(ReadTool.Plugin)),
  deps: [
    Tool.node,
    ReadToolFileSystem.node,
    FileAccess.node,
    Image.node,
    Permission.node,
    SessionInstructions.node,
    Skill.node,
    FSUtil.node,
    Environment.node,
    Location.node,
  ],
})

const permission = permissionLayer({ assert: () => Effect.void })
const config = Config.testLayer()
const imageLayer = AppNodeBuilder.build(Image.node, [Config.node.replace(config)])

const makeTestLayer = (
  options?: InstructionDiscovery.Options,
  permissions = permission,
  discovery = AppNodeBuilder.build(InstructionDiscovery.configured(options)),
) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
      Location.node,
      FSUtil.node,
      FileAccess.node,
      Environment.node,
      ReadToolFileSystem.node,
      readToolNode,
      Tool.node,
      PluginHooks.node,
      SessionInstructions.node,
      SessionModelRequest.node,
      InstructionDiscovery.node,
      Skill.node,
      Global.node,
      Image.node,
    ]),
    [
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
      Location.node.replace(tempLocationLayer),
      Permission.node.replace(permissions),
      Config.node.replace(config),
      Image.node.replace(imageLayer),
      InstructionDiscovery.node.replace(discovery),
      LocationServiceMap.node.replace(promptLocationNode),
    ],
  )

const it = testEffect(makeTestLayer())

const identity = {
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_nearby"),
}
const readCall = (
  sessionID: Session.ID,
  id: string,
  readPath: string,
  page: ReadToolFileSystem.PageInput = {},
): Parameters<Tool.Snapshot["execute"]>[0] => ({
  sessionID,
  ...identity,
  call: { type: "tool-call", id, name: "read", input: { path: readPath, ...page } },
})

const writeAgents = (file: string, content: string) => Effect.promise(() => fs.writeFile(file, content))
const mkdir = (dir: string) => Effect.promise(() => fs.mkdir(dir, { recursive: true }))

// The instruction ledger reads only synthetic rows; they must match what full history shows the model.
const synthetics = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const { db } = yield* Database.Service
    const visible = (yield* store.context(sessionID)).filter((message) => message.type === "synthetic")
    expect(yield* SessionHistory.synthetics(db, sessionID)).toEqual(visible)
    return visible
  })

// Seed a prior synthetic message with an instruction dedup ledger, simulating a prior turn
// after the Location layer was reopened (in-memory set empty).
const seedSynthetic = (sessionID: Session.ID, paths: string[]) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    yield* bus.publish(SessionEvent.Synthetic, {
      sessionID,
      text: `Instructions from: ${paths[0]}\nprior`,
      description: `Loaded ${paths[0]}`,
      metadata: { instruction: { paths } },
    })
  })

const prepared = (sessionID: Session.ID, permissions: Permission.Ruleset = []) =>
  Effect.gen(function* () {
    const instructions = yield* SessionInstructions.Service
    const request = yield* SessionModelRequest.Service
    const store = yield* SessionStore.Service
    const bus = yield* Bus.Service
    const { db } = yield* Database.Service
    const sources = yield* instructions.source({ sessionID, permissions })
    yield* InstructionState.prepare(db, bus, sources, sessionID)
    const model = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "retention-fake", provider: "fake", route: OpenAIChat.route }),
      {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        cost: [],
        limit: { context: 200_000, output: 32_000 },
      },
    )
    const history = yield* SessionHistory.entriesForRunner(db, sessionID, sources, model.ref)
    const session = yield* store.get(sessionID)
    if (!session) return yield* Effect.die(new Error("Missing test Session"))
    return yield* request.primary({
      session,
      agent: identity.agent,
      model,
      system: history.initial.map((entry) => SystemPart.make(entry.text)),
      messages: toLLMMessages(
        history.entries.map((entry) => entry.message),
        model.ref,
      ),
    })
  })

for (const policy of [
  { options: { project: false }, filename: "AGENTS.md", retained: false },
  { options: { claude: false }, filename: "CLAUDE.md", retained: false },
  { options: { claude: false }, filename: "AGENTS.md", retained: true },
]) {
  testEffect(makeTestLayer(policy.options)).live(
    `respects ${JSON.stringify(policy.options)} for complete ${policy.filename} reads`,
    () =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        const session = yield* Session.Service
        const registry = yield* Tool.Service
        const file = path.join(location.directory, policy.filename)
        yield* writeAgents(file, "policy-marker")
        const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: location.directory }) })).id
        yield* executeTool(registry, readCall(sessionID, "policy-read", file))
        expect(yield* synthetics(sessionID)).toHaveLength(policy.retained ? 1 : 0)
        expect(JSON.stringify((yield* prepared(sessionID)).request).includes("policy-marker")).toBe(policy.retained)
      }),
  )
}

testEffect(
  makeTestLayer(
    undefined,
    permission,
    Layer.effect(
      InstructionDiscovery.Service,
      Effect.gen(function* () {
        const discovery = yield* InstructionDiscovery.Service
        return InstructionDiscovery.Service.of({ ...discovery, claude: undefined })
      }),
    ).pipe(Layer.provide(AppNodeBuilder.build(InstructionDiscovery.node))),
  ),
).live("enables Claude retention when the compatibility gate is omitted", () =>
  Effect.gen(function* () {
    const location = yield* Location.Service
    const session = yield* Session.Service
    const registry = yield* Tool.Service
    const file = path.join(location.directory, "CLAUDE.md")
    yield* writeAgents(file, "omitted-claude-gate-marker")
    const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: location.directory }) })).id
    yield* executeTool(registry, readCall(sessionID, "omitted-gate", file))
    expect(yield* synthetics(sessionID)).toHaveLength(1)
    expect(JSON.stringify((yield* prepared(sessionID)).request)).toContain("omitted-claude-gate-marker")
  }),
)

testEffect(
  makeTestLayer(
    undefined,
    permissionLayer({
      assert: () =>
        Effect.fail(new Permission.BlockedError({ rules: [], permission: "read", resources: ["CLAUDE.md"] })),
    }),
  ),
).live("does not retain a denied complete instruction read", () =>
  Effect.gen(function* () {
    const location = yield* Location.Service
    const session = yield* Session.Service
    const registry = yield* Tool.Service
    yield* writeAgents(path.join(location.directory, "CLAUDE.md"), "denied-read-marker")
    const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: location.directory }) })).id
    expect((yield* executeTool(registry, readCall(sessionID, "deny-read", "CLAUDE.md"))).status).toBe("error")
    expect(yield* synthetics(sessionID)).toEqual([])
  }),
)

describe("SessionInstructions", () => {
  for (const page of [{}, { limit: 2000 }, { offset: 1 }] satisfies ReadToolFileSystem.PageInput[]) {
    it.live(
      `retains complete recognized reads once across parallel calls and compaction ${page.offset === 1 ? "with explicit offset 1" : page.limit === undefined ? "without pagination" : "with explicit limit 2000"}`,
      () =>
        Effect.gen(function* () {
          const location = yield* Location.Service
          const session = yield* Session.Service
          const registry = yield* Tool.Service
          const bus = yield* Bus.Service
          const { db } = yield* Database.Service
          const file = path.resolve(location.directory, "sub", "CLAUDE.md")
          yield* mkdir(path.dirname(file))
          yield* writeAgents(file, "retained-body-v1\r\nadditional-rule\r\n")
          const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: location.directory }) }))
            .id
          yield* prepared(sessionID)

          const attribution = { sessionID, assistantMessageID: identity.messageID }
          yield* bus.publish(SessionEvent.Step.Started, {
            ...attribution,
            agent: identity.agent,
            model: Model.Ref.make({ id: Model.ID.make("retention-fake"), providerID: Provider.ID.make("fake") }),
            started: 0,
          })
          yield* bus.publish(SessionEvent.Tool.Input.Started, { ...attribution, id: "retained-a", name: "read" })
          yield* bus.publish(SessionEvent.Tool.Called, {
            ...attribution,
            id: "retained-a",
            input: { path: file, ...page },
            executed: true,
          })
          const results = yield* Effect.all(
            [
              executeTool(registry, readCall(sessionID, "retained-a", file, page)),
              executeTool(registry, readCall(sessionID, "retained-b", file, page)),
            ],
            { concurrency: "unbounded" },
          )
          expect(results[0]?.output).toMatchObject(
            page.limit === undefined && page.offset === undefined
              ? { type: "file", encoding: "utf8" }
              : { type: "text-page", offset: 1, truncated: false },
          )
          const content = results[0]?.content
          const first = content?.[0]
          if (!content || !first) return yield* Effect.die(new Error("Missing native read body"))
          yield* bus.publish(SessionEvent.Tool.Success, {
            ...attribution,
            id: "retained-a",
            content: [first, ...content.slice(1)],
            executed: true,
          })

          const messages = yield* synthetics(sessionID)
          expect(messages.map((message) => message.metadata)).toEqual([
            { instruction: { paths: [file], retained: true } },
          ])
          expect(messages[0]?.text).not.toContain("retained-body-v1")
          const added = yield* prepared(sessionID)
          expect(JSON.stringify(added.request).match(/retained-body-v1/g)).toHaveLength(1)
          yield* bus.publish(SessionEvent.Compaction.Started, { sessionID, reason: "manual" })
          yield* bus.publish(SessionEvent.Compaction.Ended, { sessionID, reason: "manual", text: "summary" })
          expect(yield* synthetics(sessionID)).toHaveLength(0)
          expect(JSON.stringify(yield* SessionHistory.load(db, sessionID, "latest"))).not.toContain("retained-body-v1")
          const resumed = yield* prepared(sessionID)
          expect(resumed.request.system.map((part) => part.text).join("\n")).toContain("retained-body-v1")
          yield* executeTool(registry, readCall(sessionID, "retained-c", file, page))
          expect(yield* synthetics(sessionID)).toHaveLength(0)
        }),
    )
  }

  it.live("reloads edited retained files and removes deleted files from the next epoch", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const session = yield* Session.Service
      const registry = yield* Tool.Service
      const bus = yield* Bus.Service
      const file = path.join(location.directory, "CLAUDE.md")
      const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: location.directory }) })).id
      yield* writeAgents(file, "retention-old-marker")
      yield* executeTool(registry, readCall(sessionID, "adopt", file))
      yield* prepared(sessionID)
      yield* writeAgents(file, "retention-new-marker")
      const updated = yield* prepared(sessionID)
      expect(JSON.stringify(updated.request.messages)).toContain("retention-new-marker")
      yield* Effect.promise(() => fs.unlink(file))
      const removed = yield* prepared(sessionID)
      expect(JSON.stringify(removed.request.messages)).toContain(`The instructions from ${file} no longer apply.`)
      yield* bus.publish(SessionEvent.Compaction.Started, { sessionID, reason: "manual" })
      yield* bus.publish(SessionEvent.Compaction.Ended, { sessionID, reason: "manual", text: "summary" })
      expect(JSON.stringify((yield* prepared(sessionID)).request)).not.toContain("retention-new-marker")
    }),
  )

  it.live("isolates retained references between sessions and forks before adoption", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const session = yield* Session.Service
      const registry = yield* Tool.Service
      const file = path.join(location.directory, "CLAUDE.md")
      yield* writeAgents(file, "private-retained-marker")
      const parent = yield* session.create({ location: Location.Ref.make({ directory: location.directory }) })
      const other = yield* session.create({ location: Location.Ref.make({ directory: location.directory }) })
      const bus = yield* Bus.Service
      yield* bus.publish(SessionEvent.Synthetic, { sessionID: parent.id, text: "before retention" })
      const first = (yield* synthetics(parent.id))[0]
      if (!first) return yield* Effect.die(new Error("Missing fork boundary"))
      yield* executeTool(registry, readCall(parent.id, "adopt-private", file))
      yield* prepared(parent.id)
      const fork = yield* session.fork({ sessionID: parent.id, before: first.id })
      expect(JSON.stringify((yield* prepared(fork.id)).request)).not.toContain("private-retained-marker")
      expect(JSON.stringify((yield* prepared(other.id)).request)).not.toContain("private-retained-marker")
    }),
  )

  it.live("does not adopt partial, tail, clamped, unrecognized, external or ambient reads", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const session = yield* Session.Service
      const registry = yield* Tool.Service
      const discovery = yield* InstructionDiscovery.Service
      const file = path.join(location.directory, "CLAUDE.md")
      yield* writeAgents(file, "excluded-marker\nsecond-line\n")
      yield* writeAgents(path.join(location.directory, "notes.md"), "excluded-marker")
      const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: location.directory }) })).id
      for (const page of [{ offset: 1, limit: 1 }, { offset: 2 }, { offset: 9999 }, { offset: -1 }, { limit: 1 }]) {
        yield* executeTool(registry, readCall(sessionID, `partial-${JSON.stringify(page)}`, file, page))
      }
      yield* executeTool(registry, readCall(sessionID, "notes", "notes.md"))
      const external = yield* tmpdirScoped()
      const externalFile = path.join(external.path, "AGENTS.md")
      yield* writeAgents(externalFile, "external-marker")
      yield* executeTool(registry, readCall(sessionID, "external", externalFile))
      yield* writeAgents(file, "x".repeat(60_000))
      const paged = yield* executeTool(registry, readCall(sessionID, "large", file))
      expect(paged.output).toMatchObject({ type: "text-page" })
      yield* writeAgents(file, "excluded-marker")
      yield* discovery.transform((editor) =>
        editor.add(new InstructionDiscovery.File({ path: file, content: "excluded-marker" })),
      )
      yield* executeTool(registry, readCall(sessionID, "ambient", file))
      expect(yield* synthetics(sessionID)).toEqual([])
    }),
  )

  it.live("drops retained references after committed revert and current permission denial", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const session = yield* Session.Service
      const registry = yield* Tool.Service
      const bus = yield* Bus.Service
      const file = path.join(location.directory, "CLAUDE.md")
      yield* writeAgents(file, "reverted-retention-marker")
      const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: location.directory }) })).id
      yield* executeTool(registry, readCall(sessionID, "revert-adopt", file))
      const adopted = (yield* synthetics(sessionID))[0]
      if (!adopted) return yield* Effect.die(new Error("Missing retained reference"))
      yield* prepared(sessionID)
      const denied = yield* prepared(sessionID, [{ action: "read", resource: "CLAUDE.md", effect: "deny" }])
      expect(denied.request.system.map((part) => part.text).join("\n")).not.toContain("reverted-retention-marker")
      yield* bus.publish(SessionEvent.RevertEvent.Committed, { sessionID, to: adopted.id })
      expect(JSON.stringify((yield* prepared(sessionID)).request)).not.toContain("reverted-retention-marker")
    }),
  )

  it.live("applies Location-relative read denies after adoption through a symlink alias", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const session = yield* Session.Service
      const registry = yield* Tool.Service
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const filesystem = yield* FSUtil.Service
      const environment = yield* Environment.Service
      const image = yield* Image.Service
      const skills = yield* Skill.Service
      const temporary = yield* tmpdirScoped()
      const alias = path.join(temporary.path, "alias")
      const file = path.join(location.directory, "sub", "AGENTS.md")
      yield* mkdir(path.dirname(file))
      yield* writeAgents(file, "alias-retention-marker")
      yield* Effect.promise(() => fs.symlink(location.directory, alias, "dir"))
      const sessionID = (yield* session.create({
        location: Location.Ref.make({ directory: AbsolutePath.make(alias) }),
      })).id
      let reads = 0
      const aliased = AppNodeBuilder.build(LayerNode.group([readToolNode, SessionInstructions.node]), [
        Database.node.replace(Layer.succeed(Database.Service, database)),
        Bus.node.replace(Layer.succeed(Bus.Service, bus)),
        Tool.node.replace(Layer.succeed(Tool.Service, registry)),
        Location.node.replace(Layer.succeed(Location.Service, { ...location, directory: AbsolutePath.make(alias) })),
        Permission.node.replace(permission),
        Environment.node.replace(Layer.succeed(Environment.Service, environment)),
        Image.node.replace(Layer.succeed(Image.Service, image)),
        Skill.node.replace(Layer.succeed(Skill.Service, skills)),
        FSUtil.node.replace(
          Layer.succeed(FSUtil.Service, {
            ...filesystem,
            readFileStringSafe: (path) =>
              Effect.sync(() => {
                reads++
              }).pipe(Effect.andThen(filesystem.readFileStringSafe(path))),
          }),
        ),
      ])
      yield* Effect.gen(function* () {
        const instructions = yield* SessionInstructions.Service
        expect((yield* executeTool(registry, readCall(sessionID, "alias-adopt", "sub/AGENTS.md"))).status).toBe(
          "completed",
        )
        expect((yield* synthetics(sessionID)).map((message) => message.metadata)).toEqual([
          { instruction: { paths: [file], retained: true } },
        ])
        reads = 0
        const source = yield* instructions.source({
          sessionID,
          permissions: [{ action: "read", resource: "sub/AGENTS.md", effect: "deny" }],
        })
        expect(yield* Instructions.read(source)).toEqual([
          { key: Instructions.Key.make("core/session-instructions"), value: [] },
        ])
        expect(reads).toBe(0)
      }).pipe(Effect.provide(Layer.fresh(aliased)))
    }),
  )

  it.live("reloads the durable ledger in a destination Location without retaining the old project", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const session = yield* Session.Service
      const registry = yield* Tool.Service
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const file = path.join(location.directory, "CLAUDE.md")
      yield* writeAgents(file, "old-project-marker")
      const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: location.directory }) })).id
      yield* executeTool(registry, readCall(sessionID, "move-adopt", file))
      yield* prepared(sessionID)
      const destination = yield* tmpdirScoped()
      const destinationInstructions = AppNodeBuilder.build(SessionInstructions.node, [
        Database.node.replace(Layer.succeed(Database.Service, database)),
        Bus.node.replace(Layer.succeed(Bus.Service, bus)),
        Location.node.replace(Location.boundNode({ directory: AbsolutePath.make(destination.path) })),
      ])
      const moved = yield* prepared(sessionID).pipe(Effect.provide(Layer.fresh(destinationInstructions)))
      expect(JSON.stringify(moved.request)).not.toContain("old-project-marker")
      const reopened = AppNodeBuilder.build(SessionInstructions.node, [
        Database.node.replace(Layer.succeed(Database.Service, database)),
        Bus.node.replace(Layer.succeed(Bus.Service, bus)),
        Location.node.replace(Layer.succeed(Location.Service, location)),
      ])
      const restored = yield* prepared(sessionID).pipe(Effect.provide(Layer.fresh(reopened)))
      expect(JSON.stringify(restored.request.messages)).toContain("old-project-marker")
      yield* bus.publish(SessionEvent.Compaction.Started, { sessionID, reason: "manual" })
      yield* bus.publish(SessionEvent.Compaction.Ended, { sessionID, reason: "manual", text: "summary" })
      expect(JSON.stringify((yield* prepared(sessionID)).request)).toContain("old-project-marker")
    }),
  )

  it.live("preserves the prior source when fresh filesystem reads are temporarily unavailable", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const session = yield* Session.Service
      const registry = yield* Tool.Service
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const filesystem = yield* FSUtil.Service
      const file = path.join(location.directory, "CLAUDE.md")
      yield* writeAgents(file, "available-marker")
      const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: location.directory }) })).id
      yield* executeTool(registry, readCall(sessionID, "available-read", file))
      yield* prepared(sessionID)
      yield* writeAgents(file, "after-outage-marker")
      const unavailable = AppNodeBuilder.build(SessionInstructions.node, [
        Database.node.replace(Layer.succeed(Database.Service, database)),
        Bus.node.replace(Layer.succeed(Bus.Service, bus)),
        Location.node.replace(Layer.succeed(Location.Service, location)),
        FSUtil.node.replace(
          Layer.succeed(FSUtil.Service, {
            ...filesystem,
            readFileStringSafe: () => Effect.fail(new FSUtil.FileSystemError({ method: "readFileString" })),
          }),
        ),
      ])
      const during = yield* prepared(sessionID).pipe(Effect.provide(Layer.fresh(unavailable)))
      expect(JSON.stringify(during.request)).toContain("available-marker")
      expect(JSON.stringify(during.request)).not.toContain("after-outage-marker")
      const recovered = yield* prepared(sessionID)
      expect(JSON.stringify(recovered.request.messages)).toContain("after-outage-marker")
    }),
  )

  it.live("rechecks Claude compatibility after a retained path resolves to another file", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const session = yield* Session.Service
      const registry = yield* Tool.Service
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const filesystem = yield* FSUtil.Service
      const file = path.join(location.directory, "AGENTS.md")
      const target = path.join(location.directory, "CLAUDE.md")
      yield* writeAgents(file, "adopted-agent-marker")
      const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: location.directory }) })).id
      yield* executeTool(registry, readCall(sessionID, "canonical-adopt", file))
      yield* prepared(sessionID)
      const redirected = AppNodeBuilder.build(SessionInstructions.node, [
        Database.node.replace(Layer.succeed(Database.Service, database)),
        Bus.node.replace(Layer.succeed(Bus.Service, bus)),
        Location.node.replace(Layer.succeed(Location.Service, location)),
        InstructionDiscovery.node.replace(
          InstructionDiscovery.layer({ claude: false }).pipe(Layer.provide(Layer.succeed(Bus.Service, bus))),
        ),
        FSUtil.node.replace(
          Layer.succeed(FSUtil.Service, {
            ...filesystem,
            realPath: (path) => (path === file ? Effect.succeed(target) : filesystem.realPath(path)),
            readFileStringSafe: (path) =>
              path === target ? Effect.succeed("canonical-claude-marker") : filesystem.readFileStringSafe(path),
          }),
        ),
      ])
      const blocked = yield* prepared(sessionID).pipe(Effect.provide(Layer.fresh(redirected)))
      expect(JSON.stringify(blocked.request)).not.toContain("canonical-claude-marker")
      expect(JSON.stringify(blocked.request.messages)).toContain(`The instructions from ${file} no longer apply.`)
    }),
  )

  it.live("injects AGENTS.md files above a read, excludes the Location root, and dedups across reads", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const dir = location.directory
      const rootPath = path.resolve(dir, "AGENTS.md")
      const subPath = path.resolve(dir, "sub", "AGENTS.md")
      const deepPath = path.resolve(dir, "sub", "deep", "AGENTS.md")
      const otherPath = path.resolve(dir, "sub", "other", "AGENTS.md")
      yield* mkdir(path.dirname(deepPath))
      yield* mkdir(path.dirname(otherPath))
      yield* writeAgents(rootPath, "root-instructions")
      yield* writeAgents(subPath, "sub-instructions")
      yield* writeAgents(deepPath, "deep-instructions")
      yield* writeAgents(otherPath, "other-instructions\nmore rules")
      yield* Effect.promise(() => fs.writeFile(path.resolve(dir, "sub", "deep", "file.txt"), "file content"))
      yield* Effect.promise(() => fs.writeFile(path.resolve(dir, "sub", "other", "file2.txt"), "file content 2"))

      const session = yield* Session.Service
      const registry = yield* Tool.Service
      const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: dir }) })).id

      // A read deep under sub/ discovers deep and sub AGENTS.md, walking up to but
      // excluding the Location root (already supplied by core initial instructions).
      yield* executeTool(registry, readCall(sessionID, "call-deep", "sub/deep/file.txt"))

      const firstInjected = yield* synthetics(sessionID)
      expect(firstInjected).toHaveLength(1)
      expect(firstInjected[0]!.text).toBe(
        `Instructions from: ${deepPath}\ndeep-instructions\n\nInstructions from: ${subPath}\nsub-instructions`,
      )
      expect(firstInjected[0]!.description).toBe(
        `Loaded ${path.relative(dir, deepPath)}, ${path.relative(dir, subPath)}`,
      )
      // The synthetic's metadata carries the durable dedup ledger.
      expect(firstInjected[0]!.metadata).toEqual({ instruction: { paths: [deepPath, subPath] } })
      expect(firstInjected[0]!.text).not.toContain("root-instructions")

      // Complete reads retain a reference; partial reads add no reference or body.
      const read = yield* executeTool(registry, readCall(sessionID, "call-direct", "sub/other/AGENTS.md"))
      expect(read.content?.[0]).toMatchObject({ type: "text", text: expect.stringContaining("more rules") })
      const partial = yield* executeTool(
        registry,
        readCall(sessionID, "call-partial", "sub/other/AGENTS.md", { limit: 1 }),
      )
      expect(partial.metadata).toEqual({ truncated: true })
      expect(yield* synthetics(sessionID)).toHaveLength(2)

      // A sibling read under sub/other discovers only the new AGENTS.md; sub is already
      // injected for this session so it is not re-emitted, and the root is still excluded.
      yield* executeTool(registry, readCall(sessionID, "call-other", "sub/other/file2.txt"))

      const secondInjected = yield* synthetics(sessionID)
      expect(secondInjected).toHaveLength(2)
      expect(secondInjected[1]!.text).not.toContain("more rules")
      expect(secondInjected[1]!.description).toBe(`Retained ${path.relative(dir, otherPath)}`)
      expect(secondInjected[1]!.metadata).toEqual({ instruction: { paths: [otherPath], retained: true } })
      expect(secondInjected.some((message) => message.text.includes("root-instructions"))).toBe(false)
    }),
  )

  it.live("does not re-inject paths already recorded in durable session history", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const dir = location.directory
      const rootPath = path.resolve(dir, "AGENTS.md")
      const subPath = path.resolve(dir, "sub", "AGENTS.md")
      yield* mkdir(path.resolve(dir, "sub"))
      yield* writeAgents(rootPath, "root-instructions")
      yield* writeAgents(subPath, "sub-instructions")
      yield* Effect.promise(() => fs.writeFile(path.resolve(dir, "sub", "file.txt"), "content"))

      const session = yield* Session.Service
      const registry = yield* Tool.Service
      const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: dir }) })).id

      // Seed the durable history with a prior synthetic that already claims sub's AGENTS.md
      // via the instruction metadata ledger.
      yield* seedSynthetic(sessionID, [subPath])
      expect(yield* synthetics(sessionID)).toHaveLength(1)

      yield* executeTool(registry, readCall(sessionID, "call-sub", "sub/file.txt"))

      // The durable claim on the prior synthetic prevents re-injection; no new synthetic.
      expect(yield* synthetics(sessionID)).toHaveLength(1)
    }),
  )

  it.live(
    "discovers AGENTS.md on a directory listing, including the listed directory's own, and dedups with a later file read",
    () =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        const dir = location.directory
        const rootPath = path.resolve(dir, "AGENTS.md")
        const pkgPath = path.resolve(dir, "packages", "foo", "AGENTS.md")
        yield* mkdir(path.resolve(dir, "packages", "foo"))
        yield* writeAgents(rootPath, "root-instructions")
        yield* writeAgents(pkgPath, "pkg-instructions")
        yield* Effect.promise(() => fs.writeFile(path.resolve(dir, "packages", "foo", "file.txt"), "content"))

        const session = yield* Session.Service
        const registry = yield* Tool.Service
        const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: dir }) })).id

        // Listing packages/foo/ discovers its own AGENTS.md, walking up to but excluding
        // the Location root (already supplied by core initial instructions).
        yield* executeTool(registry, readCall(sessionID, "call-list", "packages/foo"))

        const firstInjected = yield* synthetics(sessionID)
        expect(firstInjected).toHaveLength(1)
        expect(firstInjected[0]!.text).toBe(`Instructions from: ${pkgPath}\npkg-instructions`)
        expect(firstInjected[0]!.description).toBe(`Loaded ${path.relative(dir, pkgPath)}`)
        expect(firstInjected[0]!.metadata).toEqual({ instruction: { paths: [pkgPath] } })
        expect(firstInjected[0]!.text).not.toContain("root-instructions")

        // A subsequent file read under the listed directory is a dedup: pkg's AGENTS.md is
        // already injected for this session, so nothing new is emitted.
        yield* executeTool(registry, readCall(sessionID, "call-file", "packages/foo/file.txt"))

        expect(yield* synthetics(sessionID)).toHaveLength(1)
      }),
  )

  it.live("re-injects nested instructions dropped from history by compaction", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const dir = location.directory
      const subPath = path.resolve(dir, "sub", "AGENTS.md")
      yield* mkdir(path.resolve(dir, "sub"))
      yield* writeAgents(path.resolve(dir, "AGENTS.md"), "root-instructions")
      yield* writeAgents(subPath, "sub-instructions")
      yield* Effect.promise(() => fs.writeFile(path.resolve(dir, "sub", "file.txt"), "content"))

      const session = yield* Session.Service
      const registry = yield* Tool.Service
      const bus = yield* Bus.Service
      const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: dir }) })).id

      yield* executeTool(registry, readCall(sessionID, "call-before", "sub/file.txt"))
      expect(yield* synthetics(sessionID)).toHaveLength(1)

      // A completed compaction truncates model-visible history at its boundary, dropping
      // the synthetic that carried sub's instructions.
      yield* bus.publish(SessionEvent.Compaction.Started, { sessionID, reason: "manual" })
      yield* bus.publish(SessionEvent.Compaction.Ended, { sessionID, reason: "manual", text: "summary" })
      expect(yield* synthetics(sessionID)).toHaveLength(0)

      // The model no longer has the rules, so the next read under the subtree must
      // re-inject them rather than trusting a stale in-memory claim.
      yield* executeTool(registry, readCall(sessionID, "call-after", "sub/file.txt"))
      expect(yield* synthetics(sessionID)).toHaveLength(1)
    }),
  )

  it.live("listing the Location root directory injects no instructions", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const dir = location.directory
      const rootPath = path.resolve(dir, "AGENTS.md")
      const subPath = path.resolve(dir, "sub", "AGENTS.md")
      yield* mkdir(path.resolve(dir, "sub"))
      yield* writeAgents(rootPath, "root-instructions")
      yield* writeAgents(subPath, "sub-instructions")

      const session = yield* Session.Service
      const registry = yield* Tool.Service
      const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: dir }) })).id

      // The walk starts and stops at the Location root: the root AGENTS.md is searched but
      // dropped by the dirname filter, and up() only walks upward so nested dirs are unseen.
      yield* executeTool(registry, readCall(sessionID, "call-root-list", "."))

      expect(yield* synthetics(sessionID)).toHaveLength(0)
    }),
  )

  it.live("loads instructions directly without a read", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const dir = location.directory
      const subPath = path.resolve(dir, "sub", "AGENTS.md")
      yield* mkdir(path.resolve(dir, "sub"))
      yield* writeAgents(subPath, "sub-instructions")

      const session = yield* Session.Service
      const sessionInstructions = yield* SessionInstructions.Service
      const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: dir }) })).id

      yield* sessionInstructions.load({ sessionID, paths: [subPath] })

      const injected = yield* synthetics(sessionID)
      expect(injected).toHaveLength(1)
      expect(injected[0]!.text).toBe(`Instructions from: ${subPath}\nsub-instructions`)
      expect(injected[0]!.description).toBe(`Loaded ${path.relative(dir, subPath)}`)
      expect(injected[0]!.metadata).toEqual({ instruction: { paths: [subPath] } })
    }),
  )

  test("toLLMMessages does not forward synthetic metadata to the provider", () => {
    const created = DateTime.makeUnsafe(0)
    const model = Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") })
    const synthetic = SessionMessage.Synthetic.make({
      id: SessionMessage.ID.make("msg_synthetic"),
      type: "synthetic",
      text: "Instructions from: /repo/sub/AGENTS.md\ncontent",
      description: "Loaded /repo/sub/AGENTS.md",
      metadata: { instruction: { paths: ["/repo/sub/AGENTS.md"] } },
      time: { created },
    })
    const messages = toLLMMessages([synthetic], model)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe("user")
    expect(messages[0]!.content).toEqual([{ type: "text", text: "Instructions from: /repo/sub/AGENTS.md\ncontent" }])
  })
})
