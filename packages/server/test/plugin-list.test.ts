import { expect } from "bun:test"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Plugin } from "@opencode/core/plugin"
import { Location } from "@opencode/schema/location"
import { AbsolutePath } from "@opencode/schema/schema"
import { Context, Effect } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { serveRoutes } from "./fixture/routes"

it.live("lists current plugins without waiting and serializes activation readiness", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const server = yield* serveRoutes({
      database: { path: ":memory:" },
      models: { fetch: false },
      config: { directory: directory.path, project: false, content: "{}" },
      fs: { filewatcher: false },
    })
    const locations = Context.get(server.context, LocationServiceMap.Service)
    yield* Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      yield* plugins.awaitActivation
      const release = yield* Effect.acquireRelease(plugins.hold(), (release) => release)
      const url = new URL("/api/plugin", "http://opencode.local")
      url.searchParams.set("location[directory]", directory.path)
      const pending = yield* Effect.promise(() => server.fetch(url)).pipe(Effect.timeout("2 seconds"))
      expect(pending.status).toBe(200)
      expect(yield* Effect.promise(() => pending.json())).toMatchObject({ ready: false })
      yield* release
      const settled = yield* Effect.promise(() => server.fetch(url))
      expect(settled.status).toBe(200)
      expect(yield* Effect.promise(() => settled.json())).toMatchObject({ ready: true })
    }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))))
  }),
)
