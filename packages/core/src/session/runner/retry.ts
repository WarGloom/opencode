export * as SessionRunnerRetry from "./retry.js"

import { AIError, isRetryable } from "@opencode/ai/effect"
import { Agent } from "@opencode/schema/agent"
import type { Credential } from "@opencode/schema/credential"
import type { SessionRetryConnectionSwitch } from "@opencode/plugin/effect/session"
import { Model } from "@opencode/schema/model"
import { SessionError } from "@opencode/schema/session-error"
import { Clock, Duration, Effect, Option, Queue, Stream } from "effect"
import { Bus } from "../../bus.js"
import { ModelRetry } from "../../model-retry.js"
import type { PluginHooks } from "../../plugin/hooks.js"
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"

export { isRetryable }

type ConnectionEvent = PluginHooks.Domains["session"]["experimental.retry.connection"]

/** How long a switched account may take to offer the same model before ordinary retry handling resumes. */
export const READY_TIMEOUT = Duration.seconds(10)

interface Connection {
  /** The connection that served the failed attempt; unknown skips the phase. */
  readonly served: string | undefined
  readonly outputStarted: boolean
  readonly hook: (event: ConnectionEvent) => Effect.Effect<void>
  /** Selects the credential only while `served` is still selected. */
  readonly switch: (credentialID: Credential.ID) => Effect.Effect<SessionRetryConnectionSwitch>
  /** Whether the same model is now available on a connection other than `served`; false after `READY_TIMEOUT`. */
  readonly ready: Effect.Effect<boolean>
}

interface Input {
  readonly cause: AIError
  readonly error: SessionError.Error
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly hook: (event: PluginHooks.Domains["session"]["retry"]) => Effect.Effect<void>
  readonly retry: boolean
  /** Only primary requests offer a connection phase. */
  readonly connection?: Connection
}

export interface Decision {
  readonly retry: true
  readonly attempt: number
  readonly delay: number
}

export const policy = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const decide = yield* ModelRetry.policy
    return (input: Input) =>
      Effect.gen(function* () {
        const next = yield* decide(input)
        if (!next) return { retry: false as const }
        // The connection phase runs even when the failure itself is not retryable, such as an exhausted quota.
        if (input.connection && (yield* switchConnection(sessionID, input, input.connection, next.attempt)))
          return { retry: true as const, attempt: next.attempt, delay: 0 }
        const event: PluginHooks.Domains["session"]["retry"] = {
          sessionID,
          agent: input.agent,
          model: input.model,
          error: input.error,
          attempt: next.attempt,
          decision: next.retry ? { retry: true, delay: next.delay } : { retry: false },
        }
        yield* input.hook(event)
        if (!event.decision.retry) return event.decision
        const normalized =
          Number.isFinite(event.decision.delay) && event.decision.delay >= 0
            ? Math.ceil(event.decision.delay)
            : next.delay
        return { retry: true as const, attempt: next.attempt, delay: normalized }
      })
  })

const switchConnection = (
  sessionID: SessionSchema.ID,
  input: Input,
  connection: Connection,
  attempt: number,
) =>
  Effect.gen(function* () {
    const served = connection.served
    if (connection.outputStarted || served === undefined) return false
    // A plugin may keep the callback; it works once and only while this phase is open.
    let open = true
    let used = false
    let outcome: SessionRetryConnectionSwitch | undefined
    yield* connection
      .hook({
        sessionID,
        agent: input.agent,
        model: input.model,
        kind: "primary",
        error: input.error,
        attempt,
        connectionKey: served,
        switch: (request) =>
          Effect.suspend(() => {
            if (!open || used) return Effect.succeed("rejected" as const)
            used = true
            return connection.switch(request.credentialID).pipe(
              Effect.tap((result) =>
                Effect.sync(() => {
                  if (open) outcome = result
                }),
              ),
            )
          }),
      })
      .pipe(
        Effect.ensuring(
          Effect.sync(() => {
            open = false
          }),
        ),
      )
    if (outcome !== "switched" && outcome !== "moved") return false
    return yield* connection.ready
  })

/**
 * Waits until `check` holds, rechecking after each `updates` item, for at most `READY_TIMEOUT`. The subscription
 * starts before the first check so an update between them is not lost.
 */
export const awaitReady = <E>(updates: Stream.Stream<unknown, E>, check: Effect.Effect<boolean>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const changed = yield* Queue.sliding<void>(1)
      yield* updates.pipe(
        Stream.runForEach(() => Queue.offer(changed, undefined)),
        Effect.ignore,
        Effect.forkScoped({ startImmediately: true }),
      )
      while (!(yield* check)) yield* Queue.take(changed)
      return true
    }),
  ).pipe(
    Effect.timeoutOption(READY_TIMEOUT),
    Effect.map(Option.isSome),
  )

export const make = (bus: Bus.Interface, sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const decide = yield* policy(sessionID)
    const wait = (input: {
      readonly decision: Decision
      readonly assistantMessageID: SessionMessage.ID
      readonly error: SessionError.Error
    }) =>
      Effect.gen(function* () {
        const scheduled = yield* Clock.currentTimeMillis
        yield* bus.publish(SessionEvent.RetryScheduled, {
          sessionID,
          assistantMessageID: input.assistantMessageID,
          attempt: input.decision.attempt,
          at: scheduled + input.decision.delay,
          error: input.error,
        })
        const remaining = Math.max(0, scheduled + input.decision.delay - (yield* Clock.currentTimeMillis))
        yield* Effect.sleep(Duration.millis(remaining))
      })
    return { decide, wait }
  })
