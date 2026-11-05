export * as SessionCommand from "./command.js"

import type { PromptInput } from "@opencode/schema/prompt-input"
import type { Session } from "@opencode/schema/session"
import type { SessionInbox } from "@opencode/schema/session-inbox"
import { Effect } from "effect"
import { Agent } from "../agent.js"
import { Command } from "../command.js"
import { Instance } from "../instance/service.js"
import { PluginHooks } from "../plugin/hooks.js"
import { Plugin } from "../plugin/service.js"

export const execute = Effect.fn("SessionCommand.execute")(function* (input: {
  session: Session.Info
  command: string
  text: string
  files?: PromptInput.Prompt["files"]
  agents?: PromptInput.Prompt["agents"]
  skills?: PromptInput.Prompt["skills"]
  delivery?: SessionInbox.Delivery
}) {
  const instances = yield* Instance.Service
  yield* Effect.gen(function* () {
    yield* Plugin.awaitActivation
    const agents = yield* Agent.Service
    const commands = yield* Command.Service
    const hooks = yield* PluginHooks.Service
    const agent = (yield* agents.select(input.session.agent)).id
    const event = {
      invocationID: Command.InvocationID.create(),
      agent,
      name: input.command,
      sessionID: input.session.id,
      delivery: input.delivery ?? "steer",
      prompt: structuredClone({
        text: input.text,
        // The guard receives a mutable copy; the caller's readonly input stays untouched.
        files: input.files?.slice(),
        agents: input.agents?.slice(),
        skills: input.skills?.slice(),
      }),
      metadata: undefined as Record<string, unknown> | undefined,
      disposition: "continue" as "continue" | "handled" | "cancelled",
      expanded: false as boolean | undefined,
    }
    yield* commands.withInvocation(
      {
        invocationID: event.invocationID,
        sessionID: event.sessionID,
        command: event.name,
        agent: event.agent,
      },
      Effect.gen(function* () {
        yield* hooks.trigger("command", "experimental.command.before", event)
        if (event.disposition !== "continue") return
        yield* commands.execute({
          name: event.name,
          invocation: {
            invocationID: event.invocationID,
            agent: event.agent,
            metadata: event.metadata,
            sessionID: event.sessionID,
            prompt: event.prompt,
            delivery: event.delivery,
            ...(event.expanded === true ? { expanded: true } : {}),
          },
        })
      }),
    )
  }).pipe(instances.provide(input.session))
})
