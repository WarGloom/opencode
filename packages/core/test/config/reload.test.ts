import path from "path"
import fs from "fs/promises"
import { writeFileSync } from "node:fs"
import { describe, expect } from "bun:test"
import { Document, Event, Info } from "@opencode/schema/config"
import { Agent } from "@opencode/core/agent"
import { Command } from "@opencode/core/command"
import { Config } from "@opencode/core/config"
import { ConfigAgentPlugin } from "@opencode/core/config/plugin/agent"
import { ConfigCommandPlugin } from "@opencode/core/config/plugin/command"
import { ConfigPolicyPlugin } from "@opencode/core/config/plugin/policy"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { ConfigReferencePlugin } from "@opencode/core/config/plugin/reference"
import { ConfigCompatibilityPlugin } from "@opencode/core/config/plugin/compatibility"
import { ConfigSkillPlugin } from "@opencode/core/config/plugin/skill"
import { ConfigWebSearchPlugin } from "@opencode/core/config/plugin/websearch"
import { Bus } from "@opencode/core/bus"
import { Integration } from "@opencode/core/integration"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Provider } from "@opencode/core/provider"
import { Reference } from "@opencode/core/reference"
import { Skill } from "@opencode/core/skill"
import { State } from "@opencode/core/state"
import { WebSearch } from "@opencode/core/websearch"
import { ShellSelect } from "@opencode/core/shell/select"
import { Job } from "@opencode/core/job"
import { SubagentJob } from "@opencode/core/session/subagent-job"
import { Global } from "@opencode/util/global"
import { Location } from "@opencode/core/location"
import { Credential } from "@opencode/core/credential"
import { WellKnown } from "@opencode/core/wellknown"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { AppProcess } from "@opencode/util/process"
import { FSUtil } from "@opencode/util/fs-util"
import { Deferred, Effect, Layer, Schema, Stream } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AbsolutePath } from "@opencode/core/schema"
import { waitUntil } from "../lib/eventually"
import { advance, drain } from "../lib/clock"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"

const it = testEffect(
  Layer.merge(
    PluginTestLayer,
    AppNodeBuilder.build(LayerNode.group([AppProcess.node, ShellSelect.node, Job.node, SubagentJob.node])),
  ),
)
const decode = Schema.decodeUnknownSync(Info)
const document = path.join(import.meta.dir, "opencode.json")

describe("config plugin reloads", () => {
  it.live("reloads a symlinked config root after edits and recreation and releases its watches", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const actual = path.join(tmp.path, "actual")
          const root = path.join(project, ".opencode")
          const file = path.join(root, "opencode.json")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.mkdir(actual)
            await fs.writeFile(path.join(actual, "opencode.json"), JSON.stringify({ shell: "initial" }))
            await fs.symlink(actual, root, process.platform === "win32" ? "junction" : "dir")
          })
          const native = yield* Watcher.Native
          const ready = yield* Deferred.make<void>()
          const counts = { active: 0 }
          yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const bus = yield* Bus.Service
            yield* Deferred.await(ready).pipe(Effect.timeout("2 seconds"))
            for (const change of [
              { shell: "edited", run: () => fs.writeFile(file, JSON.stringify({ shell: "edited" })) },
              { shell: undefined, run: () => fs.unlink(root) },
              {
                shell: "recreated",
                run: async () => {
                  await fs.writeFile(path.join(actual, "opencode.json"), JSON.stringify({ shell: "recreated" }))
                  await fs.symlink(actual, root, process.platform === "win32" ? "junction" : "dir")
                },
              },
              { shell: "later", run: () => fs.writeFile(file, JSON.stringify({ shell: "later" })) },
            ]) {
              yield* Effect.gen(function* () {
                const changed = yield* Deferred.make<void>()
                yield* Effect.acquireRelease(
                  bus.listen((event) =>
                    event.type === Event.Updated.type
                      ? config.entries().pipe(
                          Effect.flatMap((entries) =>
                            Config.latest(entries, "shell") === change.shell
                              ? Deferred.succeed(changed, undefined)
                              : Effect.void,
                          ),
                          Effect.asVoid,
                        )
                      : Effect.void,
                  ),
                  (release) => release,
                )
                yield* Effect.promise(change.run)
                yield* Deferred.await(changed).pipe(Effect.timeout("3 seconds"))
                expect(Config.latest(yield* config.entries(), "shell")).toBe(change.shell)
              }).pipe(Effect.scoped)
            }
          }).pipe(
            Effect.provide(
              liveConfig(project, {
                subscribe: (input) =>
                  native.subscribe(input).pipe(
                    Effect.map((subscription) => {
                      if (!subscription) return undefined
                      counts.active++
                      return {
                        ...subscription,
                        unsubscribe: async () => {
                          await subscription.unsubscribe()
                          counts.active--
                        },
                      }
                    }),
                    Effect.tap((subscription) =>
                      subscription && input.type === "directory" && input.target === root
                        ? Deferred.succeed(ready, undefined)
                        : Effect.void,
                    ),
                  ),
              }),
            ),
          )
          expect(counts.active).toBe(0)
        }).pipe(Effect.provide(Watcher.nativeLayer)),
      ),
    ),
  )

  for (const input of [
    { root: ".agents", global: false },
    { root: "../.claude", global: false },
    { root: "home/.agents", global: true },
    { root: "home/.claude", global: true },
  ]) {
    it.live(`loads skills when ${input.root} appears after startup`, () =>
      Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            const project = path.join(tmp.path, "project")
            const root = path.resolve(project, input.root)
            const file = path.join(project, "opencode.json")
            yield* Effect.promise(async () => {
              await fs.mkdir(path.join(project, "home"), { recursive: true })
              await fs.mkdir(path.join(project, "global"))
              await Bun.write(file, JSON.stringify({ shell: "initial" }))
            })
            return yield* Effect.gen(function* () {
              const config = yield* Config.Service
              const plugins = yield* Plugin.Service
              const skills = yield* Skill.Service
              const host = yield* PluginHost.make(plugins, "test")
              yield* ConfigCompatibilityPlugin.Plugin.effect(host)
              expect(yield* skills.list()).toEqual([])

              // Finish startup by observing an ordinary config reload before creating the root.
              yield* Effect.promise(() => Bun.write(file, JSON.stringify({ shell: "ready" })))
              yield* waitUntil(
                config.entries().pipe(Effect.map((entries) => Config.latest(entries, "shell") === "ready")),
              )
              const skill = path.join(root, "skills", "probe", "SKILL.md")
              yield* Effect.promise(() =>
                Bun.write(skill, "---\nname: probe\ndescription: Hot reload\n---\nTest skill"),
              )
              yield* waitUntil(skills.list().pipe(Effect.map((items) => items.some((item) => item.id === "probe"))))
              expect((yield* skills.list())[0]?.path).toBe(AbsolutePath.make(skill))
              yield* Effect.promise(() => fs.rm(root, { recursive: true }))
              yield* waitUntil(skills.list().pipe(Effect.map((items) => items.length === 0)))
              yield* Effect.promise(() => Bun.write(skill, "---\nname: probe\ndescription: Recreated\n---\nTest skill"))
              yield* waitUntil(skills.list().pipe(Effect.map((items) => items[0]?.description === "Recreated")))
            }).pipe(Effect.provide(liveConfig(project, undefined, { global: input.global })))
          }),
        ),
      ),
    )
  }

  it.live("retains readiness signalled synchronously during initial config startup", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        const native = Watcher.Native.of({
          subscribe: (input) =>
            Effect.sync(() => {
              if (input.type === "entries" && input.target === tmp.path) {
                // No event is emitted: only synchronous readiness can trigger the reload.
                writeFileSync(path.join(tmp.path, "opencode.json"), JSON.stringify({ references: { docs: "./docs" } }))
              }
              return { unsubscribe: () => Promise.resolve() }
            }),
        })
        return Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          const references = yield* Reference.Service
          const host = yield* PluginHost.make(plugins, "test")
          yield* ConfigReferencePlugin.Plugin.effect(host)
          yield* waitUntil(references.list().pipe(Effect.map((items) => items.some((item) => item.name === "docs"))))
          expect((yield* references.list())[0]?.path).toBe(AbsolutePath.make(path.join(tmp.path, "docs")))
        }).pipe(Effect.provide(liveConfig(tmp.path, native)))
      }),
    ),
  )

  it.live("loads the first config written while a new directory watch is starting", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, ".opencode")
          const parent = yield* Deferred.make<(update: Watcher.Update) => void>()
          const starting = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const native = Watcher.Native.of({
            subscribe: (input) =>
              Effect.gen(function* () {
                if (input.type === "entries" && input.target === tmp.path) {
                  yield* Deferred.succeed(parent, input.publish)
                }
                if (input.type === "directory" && input.target === root) {
                  yield* Deferred.succeed(starting, undefined)
                  yield* Deferred.await(release)
                }
                return { unsubscribe: () => Promise.resolve() }
              }),
          })
          return yield* Effect.gen(function* () {
            const plugins = yield* Plugin.Service
            const references = yield* Reference.Service
            const host = yield* PluginHost.make(plugins, "test")
            yield* ConfigReferencePlugin.Plugin.effect(host)
            const publish = yield* Deferred.await(parent)
            yield* Effect.promise(() => fs.mkdir(root))
            publish({ path: root, type: "create" })
            yield* Deferred.await(starting).pipe(Effect.timeout("2 seconds"))
            // No file event: the recursive native watch has not been acquired yet.
            yield* Effect.promise(() =>
              fs.writeFile(path.join(root, "opencode.json"), JSON.stringify({ references: { docs: "./docs" } })),
            )
            yield* Deferred.succeed(release, undefined)
            yield* waitUntil(references.list().pipe(Effect.map((items) => items.some((item) => item.name === "docs"))))
            expect((yield* references.list())[0]?.path).toBe(AbsolutePath.make(path.join(root, "docs")))
          }).pipe(Effect.provide(liveConfig(tmp.path, native)))
        }),
      ),
    ),
  )

  it.effect("reloads only for config documents under a watched config root", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, ".opencode")
          const json = path.join(root, "opencode.json")
          const jsonc = path.join(root, "opencode.jsonc")
          yield* Effect.promise(async () => {
            await fs.mkdir(root)
            await fs.writeFile(json, JSON.stringify({ shell: "initial" }))
          })
          const publisher = yield* Deferred.make<(update: Watcher.Update) => void>()
          const native = Watcher.Native.of({
            subscribe: (input) =>
              Effect.gen(function* () {
                if (input.type === "directory" && input.target === root) yield* Deferred.succeed(publisher, input.publish)
                return { unsubscribe: () => Promise.resolve() }
              }),
          })
          const real = yield* FSUtil.Service
          const globalDirectory = path.join(tmp.path, "global")
          const counts = { discoveries: 0 }
          // Every Config load starts by rediscovering, and discovery first resolves the global config directory.
          const counting = FSUtil.node.replace(
            Layer.succeed(FSUtil.Service, {
              ...real,
              resolve: (target) =>
                Effect.sync(() => {
                  if (target === globalDirectory) counts.discoveries++
                }).pipe(Effect.andThen(real.resolve(target))),
            }),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const raw: string[] = []
            yield* config.changes().pipe(
              Stream.runForEach((update) => Effect.sync(() => void raw.push(update.path))),
              Effect.forkScoped({ startImmediately: true }),
            )
            const publish = yield* Deferred.await(publisher)
            const shell = (value: string) =>
              config.entries().pipe(Effect.map((entries) => Config.latest(entries, "shell") === value))
            // The startup readiness reload sees this write, so observing it means startup reloads have finished.
            yield* Effect.promise(() => fs.writeFile(json, JSON.stringify({ shell: "settled" })))
            yield* advance(shell("settled"))
            const settled = counts.discoveries

            const lock = path.join(root, "oc-codex-multi-auth-accounts.json.lock")
            publish({ path: lock, type: "update" })
            yield* drain
            expect(raw).toContain(lock)
            expect(counts.discoveries).toBe(settled)

            yield* Effect.promise(() => fs.writeFile(json, JSON.stringify({ shell: "edited" })))
            publish({ path: json, type: "update" })
            yield* advance(shell("edited"))
            expect(counts.discoveries).toBe(settled + 1)

            yield* Effect.promise(() => fs.writeFile(jsonc, JSON.stringify({ shell: "created" })))
            publish({ path: jsonc, type: "create" })
            yield* advance(shell("created"))

            yield* Effect.promise(() => fs.rm(jsonc))
            publish({ path: jsonc, type: "delete" })
            yield* advance(shell("edited"))
          }).pipe(Effect.scoped, Effect.provide(liveConfig(tmp.path, native, undefined, [counting])))
        }),
      ),
    ),
  )

  for (const input of [
    {
      name: "a {file:...} dependency",
      input: "secret.txt",
      setup: (root: string) =>
        Promise.all([
          fs.writeFile(path.join(root, "opencode.json"), JSON.stringify({ shell: "{file:./secret.txt}" })),
          fs.writeFile(path.join(root, "secret.txt"), "initial"),
        ]),
      write: (file: string, shell: string) => fs.writeFile(file, shell),
    },
    {
      name: "the target of a symlinked config document",
      input: "real.json",
      setup: async (root: string) => {
        await fs.writeFile(path.join(root, "real.json"), JSON.stringify({ shell: "initial" }))
        await fs.symlink("real.json", path.join(root, "opencode.json"))
      },
      write: (file: string, shell: string) => fs.writeFile(file, JSON.stringify({ shell })),
    },
  ]) {
    it.effect(`reloads when ${input.name} under a watched config root changes`, () =>
      Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            const root = path.join(tmp.path, ".opencode")
            const file = path.join(root, input.input)
            yield* Effect.promise(async () => {
              await fs.mkdir(root)
              await input.setup(root)
            })
            const publisher = yield* Deferred.make<(update: Watcher.Update) => void>()
            const native = Watcher.Native.of({
              subscribe: (target) =>
                Effect.gen(function* () {
                  if (target.type === "directory" && target.target === root)
                    yield* Deferred.succeed(publisher, target.publish)
                  return { unsubscribe: () => Promise.resolve() }
                }),
            })
            return yield* Effect.gen(function* () {
              const config = yield* Config.Service
              const publish = yield* Deferred.await(publisher)
              const shell = (value: string) =>
                config.entries().pipe(Effect.map((entries) => Config.latest(entries, "shell") === value))
              expect(Config.latest(yield* config.entries(), "shell")).toBe("initial")
              // The startup readiness reload sees this write, so observing it means startup reloads have finished.
              yield* Effect.promise(() => input.write(file, "settled"))
              yield* advance(shell("settled"))

              yield* Effect.promise(() => input.write(file, "edited"))
              publish({ path: file, type: "update" })
              yield* advance(shell("edited"))
            }).pipe(Effect.provide(liveConfig(tmp.path, native)))
          }),
        ),
      ),
    )
  }

  for (const input of [
    { name: "a path below a regular file", reference: "./plain.txt/x" },
    { name: "a symlink loop", reference: "./loop" },
  ]) {
    it.effect(`loads an empty value for an unreadable {file:...} reference to ${input.name}`, () =>
      Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            const root = path.join(tmp.path, ".opencode")
            yield* Effect.promise(async () => {
              await fs.mkdir(root)
              await fs.writeFile(path.join(root, "plain.txt"), "plain")
              await fs.symlink("loop", path.join(root, "loop"))
              await fs.writeFile(
                path.join(root, "opencode.json"),
                JSON.stringify({ shell: `{file:${input.reference}}` }),
              )
            })
            const native = Watcher.Native.of({ subscribe: () => Effect.succeed({ unsubscribe: () => Promise.resolve() }) })
            return yield* Effect.gen(function* () {
              const config = yield* Config.Service
              expect(Config.latest(yield* config.entries(), "shell")).toBe("")
            }).pipe(Effect.provide(liveConfig(tmp.path, native)))
          }),
        ),
      ),
    )
  }

  it.effect("reloads for a dependency that changes while the load that first reads it is running", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, ".opencode")
          const json = path.join(root, "opencode.json")
          const secret = path.join(root, "secret.txt")
          yield* Effect.promise(async () => {
            await fs.mkdir(root)
            await fs.writeFile(json, JSON.stringify({ shell: "initial" }))
          })
          const publisher = yield* Deferred.make<(update: Watcher.Update) => void>()
          const native = Watcher.Native.of({
            subscribe: (target) =>
              Effect.gen(function* () {
                if (target.type === "directory" && target.target === root) yield* Deferred.succeed(publisher, target.publish)
                return { unsubscribe: () => Promise.resolve() }
              }),
          })
          const real = yield* FSUtil.Service
          const release = yield* Deferred.make<void>()
          const gate = { armed: false, reached: false, watching: false, checked: false }
          // The event check resolves the dependency's parent; nothing else resolves it while the load is paused.
          const observe = (target: string) =>
            Effect.sync(() => {
              if (gate.watching && target === root) gate.checked = true
            })
          const pausing = FSUtil.node.replace(
            Layer.succeed(FSUtil.Service, {
              ...real,
              // Pause the load right after its real read of the new dependency.
              readFileString: (file, encoding) =>
                real.readFileString(file, encoding).pipe(
                  Effect.tap(() => {
                    if (file !== secret || !gate.armed) return Effect.void
                    gate.armed = false
                    gate.reached = true
                    return Deferred.await(release)
                  }),
                ),
              realPath: (target) => real.realPath(target).pipe(Effect.tap(() => observe(target))),
              resolve: (target) => real.resolve(target).pipe(Effect.tap(() => observe(target))),
            }),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const publish = yield* Deferred.await(publisher)
            const shell = (value: string) =>
              config.entries().pipe(Effect.map((entries) => Config.latest(entries, "shell") === value))
            // The startup readiness reload sees this write, so observing it means startup reloads have finished.
            yield* Effect.promise(() => fs.writeFile(json, JSON.stringify({ shell: "settled" })))
            yield* advance(shell("settled"))

            gate.armed = true
            yield* Effect.promise(async () => {
              await fs.writeFile(secret, "first")
              await fs.writeFile(json, JSON.stringify({ shell: "{file:./secret.txt}" }))
            })
            publish({ path: json, type: "update" })
            yield* advance(() => gate.reached)

            yield* Effect.promise(() => fs.writeFile(secret, "edited"))
            gate.watching = true
            publish({ path: secret, type: "update" })
            yield* advance(() => gate.checked)
            yield* Deferred.succeed(release, undefined)
            yield* advance(shell("edited"))
          }).pipe(Effect.provide(liveConfig(tmp.path, native, undefined, [pausing])))
        }),
      ),
    ),
  )

  for (const input of [
    { file: "opencode.json", empty: false },
    { file: "../opencode.jsonc", empty: false },
    { file: ".opencode/opencode.json", empty: false },
    { file: "../.opencode/opencode.jsonc", empty: true },
  ]) {
    it.live(`loads references when ${input.file} is first created and keeps watching it`, () =>
      Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            const project = path.join(tmp.path, "project")
            const target = path.resolve(project, input.file)
            yield* Effect.promise(() => fs.mkdir(project))
            return yield* Effect.gen(function* () {
              const plugins = yield* Plugin.Service
              const references = yield* Reference.Service
              const host = yield* PluginHost.make(plugins, "test")
              yield* ConfigReferencePlugin.Plugin.effect(host)
              expect(yield* references.list()).toEqual([])

              if (input.empty) {
                yield* Effect.promise(() => fs.mkdir(path.dirname(target)))
                const config = yield* Config.Service
                yield* waitUntil(
                  config
                    .entries()
                    .pipe(
                      Effect.map((entries) =>
                        entries.some((entry) => entry.type === "directory" && entry.path === path.dirname(target)),
                      ),
                    ),
                )
              }
              yield* Effect.promise(async () => {
                await fs.mkdir(path.dirname(target), { recursive: true })
                await fs.writeFile(target, JSON.stringify({ references: { docs: "./docs" } }))
              })
              yield* waitUntil(
                references.list().pipe(Effect.map((items) => items.some((item) => item.name === "docs"))),
              )
              expect((yield* references.list())[0]?.path).toBe(
                AbsolutePath.make(path.join(path.dirname(target), "docs")),
              )
              yield* Effect.promise(() => fs.writeFile(target, JSON.stringify({ references: { next: "./next" } })))
              yield* waitUntil(
                references.list().pipe(Effect.map((items) => items.length === 1 && items[0]?.name === "next")),
              )

              yield* Effect.promise(() =>
                fs.rm(input.file.includes(".opencode/") ? path.dirname(target) : target, { recursive: true }),
              )
              yield* waitUntil(references.list().pipe(Effect.map((items) => items.length === 0)))
              yield* Effect.promise(async () => {
                await fs.mkdir(path.dirname(target), { recursive: true })
                await fs.writeFile(target, JSON.stringify({ references: { docs: "./docs" } }))
              })
              yield* waitUntil(
                references.list().pipe(Effect.map((items) => items.length === 1 && items[0]?.name === "docs")),
              )
              yield* Effect.promise(() => fs.writeFile(target, JSON.stringify({ references: { next: "./next" } })))
              yield* waitUntil(
                references.list().pipe(Effect.map((items) => items.length === 1 && items[0]?.name === "next")),
              )
            }).pipe(Effect.provide(liveConfig(project)))
          }),
        ),
      ),
    )
  }

  it.effect("preserves reference precedence and insertion order across documents", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const references = yield* Reference.Service
      const host = yield* PluginHost.make(plugins, "test")
      yield* references.transform((editor) =>
        editor.add(
          "external",
          Reference.LocalSource.make({ type: "local", path: AbsolutePath.make("/references/external") }),
        ),
      )
      yield* ConfigReferencePlugin.Plugin.effect(host)

      const result = yield* references.list()
      expect(result.map((reference) => reference.name)).toEqual(["external", "shared", "first", "second"])
      expect(result.find((reference) => reference.name === "shared")?.path).toBe(
        AbsolutePath.make(path.resolve("/config/second/shared")),
      )
    }).pipe(
      Effect.provide(
        Config.testLayer([
          referenceConfig("/config/first/opencode.json", {
            shared: "./shared",
            first: "./first",
          }),
          referenceConfig("/config/second/opencode.json", {
            shared: "./shared",
            second: "./second",
          }),
        ]),
      ),
      Effect.provideService(Global.Service, Global.Service.of(Global.make())),
    ),
  )

  it.live("reloads config-backed domains without reloading external plugins", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const providers = yield* Provider.Service
      const commands = yield* Command.Service
      const integrations = yield* Integration.Service
      const bus = yield* Bus.Service
      const plugins = yield* Plugin.Service
      const references = yield* Reference.Service
      const skills = yield* Skill.Service
      const host = yield* PluginHost.make(plugins, "test")
      const test = yield* Config.Test

      yield* ConfigAgentPlugin.Plugin.effect(host)
      yield* ConfigCommandPlugin.Plugin.effect(host)
      yield* ConfigSkillPlugin.Plugin.effect(host)
      yield* ConfigReferencePlugin.Plugin.effect(host)
      yield* ConfigProviderPlugin.Plugin.effect(host)

      expect((yield* agents.get(Agent.ID.make("first")))?.description).toBe("First agent")
      expect((yield* commands.get("first"))?.description).toBe("First command")
      expect(yield* integrations.get(Integration.ID.make("first"))).toBeDefined()
      expect((yield* skills.list()).some((skill) => skill.id === "first")).toBe(true)
      expect((yield* references.list()).map((reference) => reference.name)).toEqual(["first"])
      expect(yield* providers.get(Provider.ID.make("first"))).toBeDefined()

      yield* test.setEntries([config("second")])
      yield* Effect.yieldNow
      yield* bus.publish(Event.Updated, {})
      yield* waitUntil(
        Effect.gen(function* () {
          return (
            (yield* agents.get(Agent.ID.make("first"))) === undefined &&
            (yield* agents.get(Agent.ID.make("second")))?.description === "Second agent" &&
            (yield* commands.get("first")) === undefined &&
            (yield* commands.get("second"))?.description === "Second command" &&
            (yield* integrations.get(Integration.ID.make("first"))) === undefined &&
            (yield* integrations.get(Integration.ID.make("second"))) !== undefined &&
            (yield* references.list()).some((reference) => reference.name === "second") &&
            (yield* providers.get(Provider.ID.make("first"))) === undefined &&
            (yield* providers.get(Provider.ID.make("second"))) !== undefined &&
            (yield* skills.list()).every((skill) => skill.id !== "first") &&
            (yield* skills.list()).some((skill) => skill.id === "second")
          )
        }),
      )

      expect((yield* skills.list()).some((skill) => skill.id === "first")).toBe(false)
      expect((yield* skills.list()).some((skill) => skill.id === "second")).toBe(true)
    }).pipe(
      Effect.provide(Config.testLayer([config("first")])),
      Effect.provideService(Global.Service, Global.Service.of(Global.make())),
    ),
  )

  it.live("publishes catalog updates on boot and real changes but skips unchanged reloads", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const integrations = yield* Integration.Service
      const plugins = yield* Plugin.Service
      const websearch = yield* WebSearch.Service
      const baseHost = yield* PluginHost.make(plugins, "test")
      const test = yield* Config.Test
      const tracked = new Set<string>([
        Agent.Event.Updated.type,
        Command.Event.Updated.type,
        Skill.Event.Updated.type,
        Reference.Event.Updated.type,
        WebSearch.Event.Updated.type,
        Integration.Event.Updated.type,
        Credential.Event.Updated.type,
        Credential.Event.Switched.type,
      ])
      const counts = new Map<string, number>()
      const reloads = { agent: 0, command: 0, skill: 0, reference: 0, websearch: 0, integration: 0 }
      const count = (type: string) => counts.get(type) ?? 0
      yield* Effect.acquireRelease(
        bus.listen((event) =>
          Effect.sync(() => {
            if (!tracked.has(event.type)) return
            counts.set(event.type, count(event.type) + 1)
          }),
        ),
        (unsubscribe) => unsubscribe,
      )
      const host: typeof baseHost = {
        ...baseHost,
        agent: {
          ...baseHost.agent,
          reload: () => baseHost.agent.reload().pipe(Effect.tap(() => Effect.sync(() => void reloads.agent++))),
        },
        command: {
          ...baseHost.command,
          reload: () => baseHost.command.reload().pipe(Effect.tap(() => Effect.sync(() => void reloads.command++))),
        },
        skill: {
          ...baseHost.skill,
          reload: () => baseHost.skill.reload().pipe(Effect.tap(() => Effect.sync(() => void reloads.skill++))),
        },
        reference: {
          ...baseHost.reference,
          reload: () => baseHost.reference.reload().pipe(Effect.tap(() => Effect.sync(() => void reloads.reference++))),
        },
        websearch: {
          ...baseHost.websearch,
          reload: () => baseHost.websearch.reload().pipe(Effect.tap(() => Effect.sync(() => void reloads.websearch++))),
        },
        integration: {
          ...baseHost.integration,
          reload: () =>
            baseHost.integration.reload().pipe(Effect.tap(() => Effect.sync(() => void reloads.integration++))),
        },
      }

      let providerName = "First search"
      yield* State.batch(
        Effect.gen(function* () {
          yield* websearch.transform((editor) =>
            editor.add({ id: WebSearch.ID.make("search"), name: providerName, execute: () => Effect.succeed([]) }),
          )
          yield* ConfigAgentPlugin.Plugin.effect(host)
          yield* ConfigCommandPlugin.Plugin.effect(host)
          yield* ConfigSkillPlugin.Plugin.effect(host)
          yield* ConfigPolicyPlugin.Plugin.effect(host)
          yield* ConfigReferencePlugin.Plugin.effect(host)
          yield* ConfigWebSearchPlugin.Plugin.effect(host)
          yield* ConfigProviderPlugin.Plugin.effect(host)
        }),
      )
      expect(Object.fromEntries(counts)).toEqual({
        [Agent.Event.Updated.type]: 1,
        [Command.Event.Updated.type]: 1,
        [Skill.Event.Updated.type]: 1,
        [Reference.Event.Updated.type]: 1,
        [WebSearch.Event.Updated.type]: 1,
        [Integration.Event.Updated.type]: 1,
      })

      counts.clear()
      yield* Effect.yieldNow
      yield* bus.publish(Event.Updated, {})
      yield* waitUntil(
        Effect.sync(
          () =>
            reloads.agent === 1 &&
            reloads.command === 1 &&
            reloads.skill === 2 &&
            reloads.reference === 1 &&
            reloads.websearch === 1 &&
            reloads.integration === 1,
        ),
      )
      expect(Object.fromEntries(counts)).toEqual({})

      yield* integrations.connection.key({
        integrationID: Integration.ID.make("first"),
        key: "sk-test",
        label: "Work",
      })
      const connected = yield* integrations.get(Integration.ID.make("first"))
      expect(connected?.connections).toMatchObject([{ type: "credential", label: "Work", method: "key" }])
      expect(Object.fromEntries(counts)).toEqual({
        [Credential.Event.Updated.type]: 1,
        [Credential.Event.Switched.type]: 1,
      })

      counts.clear()
      yield* bus.publish(Event.Updated, {})
      yield* waitUntil(
        Effect.sync(
          () =>
            reloads.agent === 2 &&
            reloads.command === 2 &&
            reloads.skill === 4 &&
            reloads.reference === 2 &&
            reloads.websearch === 2 &&
            reloads.integration === 2,
        ),
      )
      expect(Object.fromEntries(counts)).toEqual({})

      yield* test.setEntries([config("second")])
      providerName = "Second search"
      yield* host.websearch.reload()
      yield* bus.publish(Event.Updated, {})
      yield* waitUntil(
        Effect.sync(
          () =>
            reloads.agent === 3 &&
            reloads.command === 3 &&
            reloads.skill === 6 &&
            reloads.reference === 3 &&
            reloads.websearch === 4 &&
            reloads.integration === 3,
        ),
      )
      expect(Object.fromEntries(counts)).toEqual({
        [Agent.Event.Updated.type]: 1,
        [Command.Event.Updated.type]: 1,
        [Skill.Event.Updated.type]: 1,
        [Reference.Event.Updated.type]: 1,
        [WebSearch.Event.Updated.type]: 1,
        [Integration.Event.Updated.type]: 1,
      })
    }).pipe(
      Effect.provide(Config.testLayer([config("first")])),
      Effect.provideService(Global.Service, Global.Service.of(Global.make())),
    ),
  )
})

function liveConfig(
  directory: string,
  native?: Watcher.NativeInterface,
  options: Config.Options = { global: false },
  replacements: LayerNode.Replacements = [],
) {
  return AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node, Reference.node, Global.node, Location.node]), [
    Config.node.replace(Config.configured(options)),
    Location.node.replace(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
    ),
    Global.node.replace(
      Global.layerWith({ config: path.join(directory, "global"), home: path.join(directory, "home") }),
    ),
    Credential.node.replace(emptyCredentialNode),
    WellKnown.node.replace(emptyWellknownNode),
    ...(native
      ? [Watcher.node.replace(Watcher.layer().pipe(Layer.provide(Layer.succeed(Watcher.Native, native))))]
      : []),
    ...replacements,
  ])
}

function config(name: string) {
  return new Document({
    type: "document",
    path: AbsolutePath.make(document),
    info: decode({
      agents: { [name]: { description: `${title(name)} agent`, mode: "subagent" } },
      commands: { [name]: { template: `${title(name)} command`, description: `${title(name)} command` } },
      skills: [path.join(import.meta.dir, "fixture", "skills", `${name}-source`)],
      references: { [name]: `/references/${name}` },
      providers: { [name]: { models: { chat: { name: `${title(name)} model` } } } },
    }),
  })
}

function referenceConfig(file: string, references: Record<string, string>) {
  return new Document({
    type: "document",
    path: AbsolutePath.make(file),
    info: decode({ references }),
  })
}

function title(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
