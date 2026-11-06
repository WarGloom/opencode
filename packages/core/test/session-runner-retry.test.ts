import { describe, expect, test } from "bun:test"
import { AIError, ProviderInternalError, RateLimitError, TransportError } from "@opencode/ai/effect"
import { Credential } from "@opencode/core/credential"
import type { SessionRetryConnection } from "@opencode/plugin/effect/session"
import { ModelRetry } from "@opencode/core/model-retry"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/core/provider"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionRunnerRetry } from "@opencode/core/session/runner/retry"
import { toSessionError } from "@opencode/core/session/to-session-error"
import { Clock, Duration, Effect, Fiber, PubSub, Stream } from "effect"
import { TestClock } from "effect/testing"
import { it } from "./lib/effect"

const timeout = new AIError({
  reason: new TransportError({ message: "Timed out", transport: "http", operation: "request", code: "Timeout" }),
})
const internal = new AIError({ reason: new ProviderInternalError({ message: "internal" }) })
const dnsFailure = new AIError({
  reason: new TransportError({
    message: "getaddrinfo ENOTFOUND opencode.ai",
    transport: "http",
    operation: "request",
    code: "ENOTFOUND",
    url: "https://opencode.ai/zen/v1/responses",
  }),
})
const refused = new AIError({
  reason: new TransportError({
    message: "Unable to connect",
    transport: "http",
    operation: "request",
    code: "ECONNREFUSED",
  }),
})

const input = (cause: AIError) => ({
  cause,
  error: toSessionError(cause),
  agent: Agent.ID.make("build"),
  model: Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }),
  hook: () => Effect.void,
  retry: SessionRunnerRetry.isRetryable(cause),
})

// Decisions for `count` consecutive failures of the same cause within one step.
const decisions = (cause: AIError, count: number) =>
  Effect.gen(function* () {
    const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
    const results: boolean[] = []
    for (let i = 0; i < count; i++) results.push((yield* policy(input(cause))).retry)
    return results
  })

describe("SessionRunnerRetry.policy", () => {
  it.effect("stops retrying transport timeouts after three attempts", () =>
    Effect.gen(function* () {
      expect(yield* decisions(timeout, 4)).toEqual([true, true, true, false])
    }),
  )

  it.effect("keeps the general allowance for other transient failures", () =>
    Effect.gen(function* () {
      expect(yield* decisions(internal, 11)).toEqual([...Array(10).fill(true), false])
    }),
  )

  it.effect("keeps retrying an unreachable host for an hour with gaps of at most 30 seconds", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
      const started = yield* Clock.currentTimeMillis
      const delays: number[] = []
      while (true) {
        const decision = yield* policy(input(dnsFailure))
        if (!decision.retry) break
        delays.push(decision.delay)
        yield* TestClock.adjust(Duration.millis(decision.delay))
      }
      const waited = (yield* Clock.currentTimeMillis) - started
      expect(delays.length).toBeGreaterThan(100)
      expect(Math.max(...delays)).toBeLessThanOrEqual(30_000)
      expect(waited).toBeGreaterThanOrEqual(Duration.toMillis(ModelRetry.UNREACHABLE_WINDOW))
      expect(waited).toBeLessThanOrEqual(Duration.toMillis(ModelRetry.UNREACHABLE_WINDOW) + 30_000)
    }),
  )

  it.effect("keeps a refused connection on the general allowance", () =>
    Effect.gen(function* () {
      expect(ModelRetry.isUnreachable(refused)).toBe(false)
      expect(yield* decisions(refused, 11)).toEqual([...Array(10).fill(true), false])
    }),
  )

  it.effect("doesn't spend the general allowance on an unreachable host", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
      for (let i = 0; i < 20; i++) expect((yield* policy(input(dnsFailure))).retry).toBe(true)
      const results: boolean[] = []
      for (let i = 0; i < 11; i++) results.push((yield* policy(input(internal))).retry)
      expect(results).toEqual([...Array(10).fill(true), false])
    }),
  )
})

describe("ModelRetry.retryOneShot", () => {
  it.effect("doesn't replay a call whose response was cut off by the network going down", () =>
    Effect.gen(function* () {
      let calls = 0
      const cutOff = new AIError({
        reason: new TransportError({
          message: "Network is down",
          transport: "http",
          operation: "read",
          code: "ENETDOWN",
        }),
      })
      yield* ModelRetry.retryOneShot(Effect.suspend(() => (calls++, Effect.fail(cutOff)))).pipe(Effect.flip)
      expect(calls).toBe(1)
    }),
  )
})

describe("toSessionError", () => {
  test("names the network when the provider's host can't be reached", () => {
    expect(toSessionError(dnsFailure)).toEqual({
      type: "provider.transport",
      message: "Can't reach opencode.ai. Check the network connection. (getaddrinfo ENOTFOUND opencode.ai)",
    })
    expect(toSessionError(refused)).toEqual({ type: "provider.transport", message: "Unable to connect" })
  })
})

const quota = new AIError({ reason: new RateLimitError({ message: "Weekly rate limit" }) })
const servedKey = "credential:cred_a"
const target = Credential.ID.make("cred_b")

// One policy with a connection phase whose plugin switches to `target` unless `switches` is false.
const connectionPolicy = (options: {
  readonly outcome?: "switched" | "moved" | "rejected"
  readonly ready?: boolean
  readonly served?: string
  readonly outputStarted?: boolean
  readonly switches?: boolean
}) =>
  Effect.gen(function* () {
    const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
    const order: string[] = []
    const switched: Credential.ID[] = []
    const events: SessionRetryConnection[] = []
    const decide = (cause: AIError) =>
      policy({
        ...input(cause),
        // Quota exhaustion is a failure the ordinary policy does not retry.
        retry: false,
        hook: () => Effect.sync(() => void order.push("retry")),
        connection: {
          served: "served" in options ? options.served : servedKey,
          outputStarted: options.outputStarted ?? false,
          hook: (event) =>
            Effect.gen(function* () {
              order.push("connection")
              events.push(event)
              if (options.switches !== false) yield* event.switch({ credentialID: target })
            }),
          switch: (credentialID) =>
            Effect.sync(() => {
              switched.push(credentialID)
              return options.outcome ?? "switched"
            }),
          ready: Effect.sync(() => {
            order.push("ready")
            return options.ready ?? true
          }),
        },
      })
    return { decide, order, switched, events }
  })

describe("SessionRunnerRetry connection phase", () => {
  for (const outcome of ["switched", "moved"] as const)
    it.effect(`retries the same model at once after a ${outcome} connection, without retry hooks`, () =>
      Effect.gen(function* () {
        const test = yield* connectionPolicy({ outcome })
        // The ordinary policy declines this failure, yet the connection phase still runs.
        const decision = yield* test.decide(quota)
        expect(decision).toEqual({ retry: true, attempt: 2, delay: 0 })
        expect(test.order).toEqual(["connection", "ready"])
        expect(test.switched).toEqual([target])
        expect(test.events[0]).toMatchObject({ kind: "primary", attempt: 2, connectionKey: servedKey })
      }),
    )

  for (const fixture of [
    { name: "a rejected switch", options: { outcome: "rejected" as const }, order: ["connection", "retry"] },
    { name: "no switch", options: { switches: false }, order: ["connection", "retry"] },
    { name: "a switched model that never becomes ready", options: { ready: false }, order: ["connection", "ready", "retry"] },
    { name: "output that already started", options: { outputStarted: true }, order: ["retry"] },
    { name: "an unknown connection", options: { served: undefined }, order: ["retry"] },
  ])
    it.effect(`falls through to the unchanged retry hooks after ${fixture.name}`, () =>
      Effect.gen(function* () {
        const test = yield* connectionPolicy(fixture.options)
        expect(yield* test.decide(quota)).toEqual({ retry: false })
        expect(test.order).toEqual(fixture.order)
      }),
    )

  it.effect("spends the general retry allowance and skips the phase once it is exhausted", () =>
    Effect.gen(function* () {
      const test = yield* connectionPolicy({})
      const results: boolean[] = []
      for (let i = 0; i < 11; i++) results.push((yield* test.decide(internal)).retry)
      expect(results).toEqual([...Array(10).fill(true), false])
      expect(test.switched).toHaveLength(10)
      expect(test.order.filter((item) => item === "retry")).toEqual([])
    }),
  )

  it.effect("writes once per event and rejects a second switch or one kept past the phase", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
      const outcomes: string[] = []
      const writes: Credential.ID[] = []
      let kept: SessionRetryConnection | undefined
      yield* policy({
        ...input(quota),
        connection: {
          served: servedKey,
          outputStarted: false,
          hook: (event) =>
            Effect.gen(function* () {
              kept = event
              outcomes.push(yield* event.switch({ credentialID: target }))
              outcomes.push(yield* event.switch({ credentialID: target }))
            }),
          switch: (credentialID) =>
            Effect.sync(() => {
              writes.push(credentialID)
              return "switched" as const
            }),
          ready: Effect.succeed(true),
        },
      })
      if (!kept) throw new Error("Expected the connection hook to run")
      outcomes.push(yield* kept.switch({ credentialID: target }))
      expect(outcomes).toEqual(["switched", "rejected", "rejected"])
      expect(writes).toEqual([target])
    }),
  )
})

describe("SessionRunnerRetry.awaitReady", () => {
  it.effect("subscribes before the first check so an update between them releases it", () =>
    Effect.gen(function* () {
      const updates = yield* PubSub.unbounded<void>()
      let checks = 0
      // The first check publishes the update it then misses; only an earlier subscription sees it.
      const check = Effect.gen(function* () {
        checks++
        if (checks === 1) yield* PubSub.publish(updates, undefined)
        return checks > 1
      })
      expect(yield* SessionRunnerRetry.awaitReady(Stream.fromPubSub(updates), check)).toBe(true)
      expect(checks).toBe(2)
    }),
  )

  it.effect("gives up after the readiness timeout", () =>
    Effect.gen(function* () {
      const fiber = yield* SessionRunnerRetry.awaitReady(Stream.never, Effect.succeed(false)).pipe(
        Effect.forkChild({ startImmediately: true }),
      )
      yield* TestClock.adjust(SessionRunnerRetry.READY_TIMEOUT)
      expect(yield* Fiber.join(fiber)).toBe(false)
    }),
  )
})
