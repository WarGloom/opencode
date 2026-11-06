import { describe, expect } from "bun:test"
import { ToolDefinition } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import type { SessionRequestKind } from "@opencode/plugin/effect/session"
import { Location } from "@opencode/core/location"
import { Integration } from "@opencode/core/integration"
import { IntegrationConnection } from "@opencode/core/integration/connection"
import { Credential } from "@opencode/core/credential"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { DateTime, Effect, Ref, Stream } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/http"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

const KINDS: ReadonlyArray<SessionRequestKind> = ["primary", "compaction", "title", "generate"]

const session = Session.Info.make({
  id: Session.ID.make("ses_hook_kind"),
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})
const model = SessionRunnerModel.resolved(OpenAIChat.route.model({ id: "gpt-5.5", provider: "test" }), {
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  cost: [],
  limit: { context: 200_000, output: 32_000 },
})
const transport = SessionModelTransport.Service.of({
  bind: () => ({ execute: () => Effect.die("unused WebSocket execution") }),
  close: () => Effect.void,
  closeAll: Effect.void,
})

describe("SessionModelRequest HTTP hooks", () => {
  it.effect(
    "advertises only supported freeform formats without removing tools or changing the shared definitions",
    () =>
      Effect.gen(function* () {
        const inputSchema = { type: "object", properties: { value: { type: "string" } }, required: ["value"] }
        const formats = [
          { type: "text" },
          { type: "regex", pattern: "[0-9]+" },
          { type: "lark", grammar: 'start: "x"' },
        ] as const
        const tools = {
          definitions: formats.map(
            (freeform) => new ToolDefinition({ name: freeform.type, description: "", inputSchema, freeform }),
          ),
          execute: () => Effect.die("unused tool execution"),
        }
        const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
        const cases: Array<typeof model.capabilities.freeform> = [undefined, [], ["text", "lark"], ["regex"]]
        for (const supported of cases) {
          const prepared = yield* requests.primary({
            session,
            agent: Agent.ID.make("build"),
            model: { ...model, capabilities: { ...model.capabilities, freeform: supported } },
            system: [],
            messages: [],
            tools,
          })
          expect(
            prepared.request.tools.map((tool) => tool.type === "tool" && [tool.name, tool.inputSchema, tool.freeform]),
          ).toEqual(
            formats.map((format) => [format.type, inputSchema, supported?.includes(format.type) ? format : undefined]),
          )
        }
      }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
  )

  for (const selection of [
    {
      connection: IntegrationConnection.CredentialInfo.make({
        type: "credential",
        id: Credential.ID.make("credential-a"),
        label: "A",
        method: "key",
      }),
      key: "credential:credential-a",
    },
    { connection: IntegrationConnection.EnvInfo.make({ type: "env", name: "FIXTURE_KEY_A" }), key: "env:FIXTURE_KEY_A" },
    { connection: undefined, key: undefined },
  ]) {
    it.effect(`retains selected connection ${selection.key ?? "unknown"} on every request kind after a switch`, () =>
      Effect.gen(function* () {
        // Given a provider alias whose integration selects connection A.
        const integrations = yield* Integration.Service
        const providers = yield* Provider.Service
        const active = yield* Ref.make<IntegrationConnection.Info | undefined>(selection.connection)
        const provider = Provider.Info.make({
          ...Provider.Info.empty(Provider.ID.make("alias")),
          integrationID: Integration.ID.make("integration"),
        })
        const resolver = yield* ModelResolver.Service.pipe(
          Effect.provide(ModelResolver.layer),
          Effect.provideService(Provider.Service, { ...providers, get: () => Effect.succeed(provider) }),
          Effect.provideService(Integration.Service, {
            ...integrations,
            connection: {
              ...integrations.connection,
              active: (id) => (id === provider.integrationID ? Ref.get(active) : Effect.die("Wrong integration")),
              resolve: () => Effect.undefined,
            },
          }),
        )
        const resolved = yield* resolver.resolveModel(
          Model.Info.make({
            ...Model.Info.default(provider.id, Model.ID.make("gpt-5.5")),
            package: "@opencode/ai/providers/openai",
          }),
        )
        yield* Ref.set(active, IntegrationConnection.EnvInfo.make({ type: "env", name: "FIXTURE_KEY_B" }))
        const hooks = yield* PluginHooks.Service
        const seen: Array<{ hook: string; kind: SessionRequestKind; agent: Agent.ID; connectionKey: string | undefined }> = []
        yield* hooks.register("session", "model.request", (event) =>
          Effect.sync(() => {
            seen.push({ hook: "model", kind: event.kind, agent: event.agent, connectionKey: event.connectionKey })
          }),
        )
        yield* hooks.register("session", "http.request", (event) =>
          Effect.sync(() => {
            seen.push({ hook: "request", kind: event.kind, agent: event.agent, connectionKey: event.connectionKey })
          }),
        )
        yield* hooks.register("session", "http.response", (event) =>
          Effect.sync(() => {
            seen.push({ hook: "response", kind: event.kind, agent: event.agent, connectionKey: event.connectionKey })
            expect(event.response.bodyUsed).toBe(false)
          }),
        )
        const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))

        // When the resolved model makes a request after the active connection changes to B.
        for (const kind of KINDS) {
          const prepared = yield* requests[kind]({
            session,
            agent: Agent.ID.make("build"),
            model: resolved,
            system: [],
            messages: [],
          })
          const http = prepared.options.http
          if (!http) throw new Error(`Expected HTTP middleware for ${kind}`)
          const response = yield* http(HttpClientRequest.post("https://example.test/v1/chat/completions"), (request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response("quota-stream", { status: 200 }))),
          )
          expect(yield* response.text).toBe("quota-stream")
        }

        // Then hooks retain A's identity (or unknown) while the response body remains readable.
        expect(seen).toEqual(
          KINDS.flatMap((kind) => [
            { hook: "model", kind, agent: Agent.ID.make("build"), connectionKey: selection.key },
            { hook: "request", kind, agent: Agent.ID.make("build"), connectionKey: selection.key },
            { hook: "response", kind, agent: Agent.ID.make("build"), connectionKey: selection.key },
          ]),
        )
      }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
    )
  }

  it.effect("sends a kept request's original body and a replaced request's new body", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      let replace = false
      yield* hooks.register("session", "http.request", (event) =>
        Effect.sync(() => {
          if (replace) {
            event.request = new Request(event.request.url, { method: "POST", body: '{"replaced":true}' })
            return
          }
          event.request.headers.set("x-plugin", "kept")
        }),
      )
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
      const prepared = yield* requests.primary({
        session,
        agent: Agent.ID.make("build"),
        model,
        system: [],
        messages: [],
      })
      const http = prepared.options.http
      if (!http) throw new Error("Expected HTTP middleware")
      const original = HttpClientRequest.post("https://example.test/v1/chat/completions").pipe(
        HttpClientRequest.bodyText('{"messages":[]}', "application/json"),
      )
      const send = () => {
        const sent: HttpClientRequest.HttpClientRequest[] = []
        return http(original, (request) =>
          Effect.sync(() => {
            sent.push(request)
            return HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 }))
          }),
        ).pipe(Effect.map(() => sent[0]!))
      }

      const kept = yield* send()
      expect(kept.body).toBe(original.body)
      expect(kept.headers["x-plugin"]).toBe("kept")

      replace = true
      const replaced = yield* send()
      expect(replaced.body._tag).toBe("Uint8Array")
      if (replaced.body._tag !== "Uint8Array") return
      expect(new TextDecoder().decode(replaced.body.body)).toBe('{"replaced":true}')
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
  )

  it.effect("keeps hook edits to a tool schema out of later requests", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          const input = event.tools.lookup!.input as { required: string[] }
          input.required.push("extra")
        }),
      )
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
      const inputSchema = { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
      const tools = {
        definitions: [new ToolDefinition({ name: "lookup", description: "Lookup", inputSchema })],
        execute: () => Effect.die("unused tool execution"),
      }

      const required = yield* Effect.forEach([1, 2], () =>
        requests
          .primary({ session, agent: Agent.ID.make("build"), model, system: [], messages: [], tools })
          .pipe(
            Effect.map((prepared) => {
              const tool = prepared.request.tools[0]
              return tool?.type === "tool" ? tool.inputSchema.required : undefined
            }),
          ),
      )

      expect(required).toEqual([
        ["id", "extra"],
        ["id", "extra"],
      ])
      expect(inputSchema.required).toEqual(["id"])
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
  )

  it.effect("offers the WebSocket executor alongside HTTP hooks and routes the WebSocket hooks", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const seen: string[] = []
      yield* hooks.register("session", "http.request", () => Effect.sync(() => void seen.push("http.request")))
      yield* hooks.register("session", "experimental.ws.handshake", (event) =>
        Effect.sync(() => {
          seen.push(`handshake:${event.kind}:${event.url}`)
          event.headers.authorization = "Bearer minted"
          delete event.headers["api-key"]
        }),
      )
      yield* hooks.register("session", "experimental.ws.send", (event) =>
        Effect.sync(() => {
          seen.push(`send:${event.kind}:${event.frame}`)
          event.frame = `${event.frame}+plugin`
        }),
      )
      yield* hooks.register("session", "experimental.ws.receive", (event) =>
        Effect.sync(() => {
          seen.push(`receive:${event.kind}:${event.frame}`)
          event.frame = event.frame.toUpperCase()
        }),
      )
      const bound: Array<{ url: string; headers: Record<string, string> }> = []
      const frames: string[] = []
      const websocketTransport = SessionModelTransport.Service.of({
        bind: (_sessionID, interceptor) => ({
          execute: () =>
            Effect.gen(function* () {
              if (!interceptor?.handshake || !interceptor.send || !interceptor.receive)
                throw new Error("Expected a full WebSocket interceptor")
              bound.push(
                yield* interceptor.handshake({ url: "wss://example.test/v1/responses", headers: { "api-key": "k" } }),
              )
              frames.push(yield* interceptor.send("create"))
              frames.push(yield* interceptor.receive("created"))
              return { frames: Stream.empty, complete: Effect.void }
            }),
        }),
        close: () => Effect.void,
        closeAll: Effect.void,
      })
      const requests = yield* SessionModelRequest.Service.pipe(
        Effect.provide(SessionModelRequest.layer),
        Effect.provideService(SessionModelTransport.Service, websocketTransport),
      )
      const prepared = yield* requests.primary({
        session,
        agent: Agent.ID.make("build"),
        model: SessionRunnerModel.resolved(OpenAIChat.route.model({ id: "gpt-5.5", provider: "test" }), {
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          cost: [],
          limit: { context: 200_000, output: 32_000 },
          transport: "websocket",
        }),
        system: [],
        messages: [],
        webSocket: "session",
      })

      expect(prepared.options.http).toBeDefined()
      expect(prepared.options.webSocket).toBeDefined()
      yield* prepared.options.webSocket!.execute({} as never)
      expect(bound).toEqual([{ url: "wss://example.test/v1/responses", headers: { authorization: "Bearer minted" } }])
      expect(frames).toEqual(["create+plugin", "CREATED"])
      expect(seen).toEqual([
        "handshake:primary:wss://example.test/v1/responses",
        "send:primary:create",
        "receive:primary:created",
      ])
    }),
  )
})
