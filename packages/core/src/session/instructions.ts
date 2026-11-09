export * as SessionInstructions from "./instructions.js"

import { basename, relative } from "path"
import { createPatch } from "diff"
import { Context, Effect, Layer, Ref, Schema } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { FSUtil } from "@opencode/util/fs-util"
import { Location } from "../location.js"
import { InstructionDiscovery } from "../instruction-discovery.js"
import { Instructions } from "../instructions/index.js"
import { Permission } from "../permission.js"
import { SessionEvent } from "./event.js"
import { MessageDecodeError } from "./error.js"
import { SessionSchema } from "./schema.js"
import { previouslyInjected, retainedPaths } from "./instruction-ledger.js"

export interface Interface {
  readonly load: (input: {
    readonly sessionID: SessionSchema.ID
    readonly paths: ReadonlyArray<string>
    readonly retained?: { readonly content: string; readonly page?: true }
  }) => Effect.Effect<void, MessageDecodeError | FSUtil.Error>
  readonly source: (input: {
    readonly sessionID: SessionSchema.ID
    readonly permissions: Permission.Ruleset
  }) => Effect.Effect<Instructions.List>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionInstructions") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const fs = yield* FSUtil.Service
    const db = (yield* Database.Service).db
    const location = yield* Location.Service
    const discovery = yield* InstructionDiscovery.Service
    // Resolved once for the Location layer; the synthetic text and dedup ledger keep
    // absolute paths, but the human-facing description shows paths relative to the project
    // root so opening a subdirectory still describes paths from the project root.
    const root = yield* fs.resolve(location.project.directory)
    const directory = yield* fs.resolve(location.directory)
    // Same-step parallel reads settle concurrently, so an in-memory claim guards each
    // Session/path pair while a load is in flight. The claim is released once the load
    // settles. Advisory paths use active history; retained paths use the full ledger.
    const inFlight = yield* Ref.make<Map<SessionSchema.ID, Set<string>>>(new Map())
    const readHashes = yield* Ref.make<Map<string, Instructions.Hash>>(new Map())

    const load = Effect.fn("SessionInstructions.load")(function* (input: Parameters<Interface["load"]>[0]) {
      if (!discovery.project) return
      const paths = yield* Effect.forEach([...new Set(input.paths)], fs.resolve)
      const retained = input.retained !== undefined
      if (retained && !Array.isArray(yield* discovery.list())) return
      const candidates = retained ? yield* eligible(paths) : paths
      const claimKey = (path: string) => `${retained ? "retained" : "advisory"}:${path}`
      const claimed = yield* Ref.modify(inFlight, (map) => {
        const existing = map.get(input.sessionID) ?? new Set<string>()
        const newlyClaimed = candidates.filter((path) => !existing.has(claimKey(path)))
        if (newlyClaimed.length === 0) return [newlyClaimed, map]
        const next = new Map(map)
        next.set(input.sessionID, new Set([...existing, ...newlyClaimed.map(claimKey)]))
        return [newlyClaimed, next]
      })
      if (claimed.length === 0) return
      yield* Effect.gen(function* () {
        const retainedFiles = yield* retainedPaths(db, input.sessionID)
        const alreadyInjected = retained
          ? retainedFiles
          : new Set([...retainedFiles, ...(yield* previouslyInjected(db, input.sessionID))])
        const toInject = claimed.filter((path) => !alreadyInjected.has(path))
        if (toInject.length === 0) return
        const complete = input.retained
        const files = yield* Effect.forEach(
          toInject,
          (path) =>
            fs.readFileStringSafe(path).pipe(
              Effect.map((content) => {
                if (content === undefined) return undefined
                if (complete) {
                  const decoded = content.replace(/^\uFEFF/, "")
                  const observed = complete.page ? decoded.replace(/\r(?=\n|$)/g, "").replace(/\n$/, "") : decoded
                  if (observed !== complete.content) return undefined
                }
                return { path, content }
              }),
            ),
          { concurrency: "unbounded" },
        )
        const readable = files.filter((file): file is { path: string; content: string } => file !== undefined)
        if (readable.length === 0) return
        // Publish directly rather than through Session.synthetic: a Location-scoped layer
        // cannot depend on Session (it routes through LocationServiceMap, forming a type
        // cycle with this node). The durable publish commits the synthetic and its metadata
        // ledger atomically, so releasing the claim afterwards cannot readmit the paths.
        yield* bus.publish(SessionEvent.Synthetic, {
          sessionID: input.sessionID,
          text: retained
            ? `Retained instruction files for this Session: ${readable.map((file) => describePath(root, file.path)).join(", ")}`
            : render(readable),
          description: `${retained ? "Retained" : "Loaded"} ${readable.map((file) => describePath(root, file.path)).join(", ")}`,
          metadata: {
            instruction: { paths: readable.map((file) => file.path), ...(retained ? { retained: true } : {}) },
          },
        })
        if (retained)
          yield* Ref.update(
            readHashes,
            (current) =>
              new Map([
                ...current,
                ...readable.map(
                  (file) => [`${input.sessionID}:${file.path}`, Instructions.hash(file.content)] as const,
                ),
              ]),
          )
      }).pipe(
        Effect.ensuring(
          Ref.update(inFlight, (map) => {
            const existing = map.get(input.sessionID)
            if (!existing) return map
            const remaining = new Set([...existing].filter((path) => !claimed.some((file) => claimKey(file) === path)))
            const next = new Map(map)
            if (remaining.size === 0) next.delete(input.sessionID)
            else next.set(input.sessionID, remaining)
            return next
          }),
        ),
      )
    })

    const eligible = Effect.fn("SessionInstructions.eligible")(function* (paths: readonly string[]) {
      if (!discovery.project || paths.length === 0) return []
      const ambient = yield* discovery.list()
      const supplied = new Set(Array.isArray(ambient) ? ambient.map((file) => file.path) : [])
      return paths.filter(
        (path) => FSUtil.contains(directory, path) && recognized(path, discovery.claude) && !supplied.has(path),
      )
    })

    const source = Effect.fn("SessionInstructions.source")(function* (input: Parameters<Interface["source"]>[0]) {
      const paths = yield* retainedPaths(db, input.sessionID).pipe(Effect.orDie)
      const allowed = (yield* eligible([...paths])).filter(
        (path) =>
          Permission.evaluate("read", relative(directory, path).replaceAll("\\", "/"), input.permissions).effect !==
          "deny",
      )
      const active = yield* previouslyInjected(db, input.sessionID).pipe(Effect.orDie)
      const hashes = yield* Ref.updateAndGet(
        readHashes,
        (current) =>
          new Map(
            [...current].filter(
              ([key]) => !key.startsWith(`${input.sessionID}:`) || active.has(key.slice(input.sessionID.length + 1)),
            ),
          ),
      )
      const supplied = new Map(
        allowed.flatMap((path) => {
          const hash = hashes.get(`${input.sessionID}:${path}`)
          return hash === undefined ? [] : [[path, hash] as const]
        }),
      )
      // Forks inherit newest epoch values, but may precede the retained reference.
      const renderable = (files: ReadonlyArray<InstructionDiscovery.File>) =>
        files.filter((file) => allowed.includes(file.path))
      return Instructions.make<ReadonlyArray<InstructionDiscovery.File>>({
        key: Instructions.Key.make("core/session-instructions"),
        codec: Schema.toCodecJson(Schema.Array(InstructionDiscovery.File)),
        read: Effect.gen(function* () {
          if (paths.size === 0 || !discovery.project) return []
          const ambient = yield* discovery.list()
          if (!Array.isArray(ambient)) return Instructions.unavailable
          const files = yield* Effect.forEach(allowed, (path) =>
            Effect.gen(function* () {
              const canonical = yield* fs.realPath(path).pipe(
                Effect.catchIf(
                  (error) => error.reason._tag === "NotFound" || FSUtil.isAccessDenied(error),
                  () => Effect.undefined,
                ),
              )
              if (
                canonical === undefined ||
                !FSUtil.contains(directory, canonical) ||
                !recognized(canonical, discovery.claude)
              )
                return
              if (
                Permission.evaluate("read", relative(directory, canonical).replaceAll("\\", "/"), input.permissions)
                  .effect === "deny"
              )
                return
              const content = yield* fs.readFileStringSafe(canonical)
              return content === undefined ? undefined : new InstructionDiscovery.File({ path, content })
            }),
          )
          return files.filter((file) => file !== undefined)
        }).pipe(Effect.orElseSucceed(() => Instructions.unavailable)),
        render: {
          initial: (files) => render(renderable(files)),
          changed: (before, after) => changed(before, after, supplied),
        },
      }).map((source) => ({
        ...source,
        initial: (value: Schema.Json) =>
          allowed.length === 0 || (Array.isArray(value) && value.length === 0) ? undefined : source.initial(value),
      }))
    })

    return Service.of({ load, source })
  }),
)

function recognized(path: string, claude?: boolean) {
  return basename(path) === "AGENTS.md" || (claude !== false && basename(path) === "CLAUDE.md")
}

// Paths are normally discovered under the project root, so the description shows them
// relative to it. A directly-loaded path outside the root falls back to its absolute form
// rather than emitting `../..` chains.
function describePath(root: string, path: string) {
  return FSUtil.contains(root, path) ? relative(root, path) : path
}

const render = (files: ReadonlyArray<InstructionDiscovery.File>) =>
  files.length === 0
    ? "No session instruction files are retained."
    : files.map((file) => `Instructions from: ${file.path}\n${file.content}`).join("\n\n")

function changed(
  previous: ReadonlyArray<InstructionDiscovery.File>,
  current: ReadonlyArray<InstructionDiscovery.File>,
  supplied: ReadonlyMap<string, Instructions.Hash>,
) {
  const changes = Instructions.diffByKey(
    previous,
    current,
    (file) => file.path,
    (before, after) => before.content !== after.content,
  )
  const parts = [
    ...changes.removed.map((file) => `The instructions from ${file.path} no longer apply.`),
    // The complete native read already supplied the added file's body.
    ...changes.added.map((file) =>
      supplied.get(file.path) === Instructions.hash(file.content)
        ? `The instructions from ${file.path} now apply for this Session.`
        : `New instructions apply from:\n${render([file])}`,
    ),
    ...changes.changed.map(({ previous: before, current: after }) => {
      const patch = createPatch(after.path, before.content, after.content, "", "", { context: 3 })
      const diff = [
        `The instructions from ${after.path} changed. Here's the diff:`,
        "```diff",
        patch.slice(patch.indexOf("@@")).trimEnd(),
        "```",
      ].join("\n")
      const replacement = `The instructions changed:\n${render([after])}`
      return diff.length < replacement.length ? diff : replacement
    }),
  ]
  return parts.length === 0 ? undefined : parts.join("\n\n")
}

export const node = makeLocationNode({
  name: "session-instructions",
  layer,
  deps: [Bus.node, Database.node, FSUtil.node, Location.node, InstructionDiscovery.node],
})
