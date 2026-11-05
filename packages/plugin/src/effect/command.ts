import type { CommandApi } from "@opencode/client/effect/api"
import type { PromptInput } from "@opencode/schema/prompt-input"
import type { Session } from "@opencode/schema/session"
import type { SessionInbox } from "@opencode/schema/session-inbox"
import type { Agent } from "@opencode/schema/agent"
import type { Command } from "@opencode/schema/command"
import type { Effect, Types } from "effect"
import type { Hooks, Transform } from "./registration.js"

export interface CommandInvocation {
  readonly invocationID: Command.InvocationID
  readonly agent: Agent.ID
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly sessionID: Session.ID
  readonly prompt: PromptInput.Prompt
  readonly delivery: SessionInbox.Delivery
  /** Set when an `experimental.command.before` hook already expanded `prompt.text`; use it verbatim. */
  readonly expanded?: boolean
}

export interface CommandBefore {
  readonly invocationID: Command.InvocationID
  readonly agent: Agent.ID
  readonly name: string
  readonly sessionID: Session.ID
  readonly delivery: SessionInbox.Delivery
  prompt: Types.DeepMutable<PromptInput.Prompt>
  metadata?: Record<string, unknown>
  disposition: "continue" | "handled" | "cancelled"
  /** Set to true after replacing `prompt.text` with a full expansion, so the command does not render it again. */
  expanded?: boolean
}

export interface CommandHooks {
  readonly "experimental.command.before": CommandBefore
}

export interface CommandDefinition {
  readonly name: string
  readonly description?: string
  readonly execute: (input: CommandInvocation) => Effect.Effect<void, unknown>
}

export interface CommandEditor {
  add(definition: CommandDefinition): void
}

export interface CommandDomain extends Pick<CommandApi<unknown>, "list"> {
  readonly hook: Hooks<CommandHooks>
  readonly transform: Transform<CommandEditor>
  readonly reload: () => Effect.Effect<void>
}
