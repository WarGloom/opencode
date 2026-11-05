import type { CommandApi } from "@opencode/client/promise/api"
import type { PromptInput } from "@opencode/schema/prompt-input"
import type { Session } from "@opencode/schema/session"
import type { SessionInbox } from "@opencode/schema/session-inbox"
import type { Agent } from "@opencode/schema/agent"
import type { Command } from "@opencode/schema/command"
import type { Hooks, Transform } from "./registration.js"
import type { CommandHooks } from "../effect/command.js"
export type { CommandBefore, CommandHooks } from "../effect/command.js"

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

export interface CommandDefinition {
  readonly name: string
  readonly description?: string
  readonly execute: (input: CommandInvocation) => Promise<void>
}

export interface CommandEditor {
  add(definition: CommandDefinition): void
}

export interface CommandDomain extends Pick<CommandApi, "list"> {
  readonly hook: Hooks<CommandHooks>
  readonly transform: Transform<CommandEditor>
  readonly reload: () => Promise<void>
}
