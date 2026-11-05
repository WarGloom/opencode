import type { Effect } from "effect"
import type { Session } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { AcceptSkillsInput, PrepareInput, Receipt, RunRef, StartInput, Target, WaitInput, WaitResult } from "../subagent.js"

/** Native, plugin-scoped subagent admission. Experimental. */
export interface SubagentDomain {
  readonly prepare: (input: PrepareInput) => Effect.Effect<Receipt, unknown>
  /** Accepts the whole skill batch for the prepared child under the parent's authority. */
  readonly acceptSkills: (input: AcceptSkillsInput) => Effect.Effect<readonly SessionMessage.SkillActivation[], unknown>
  readonly start: (input: StartInput) => Effect.Effect<Receipt, unknown>
  readonly get: (input: Target) => Effect.Effect<Receipt | undefined, unknown>
  readonly wait: (input: WaitInput) => Effect.Effect<WaitResult, unknown>
  readonly cancel: (input: Target) => Effect.Effect<Receipt, unknown>
  /** Lists durable receipts without resuming recovered work. */
  readonly reconcile: (input?: { readonly parentSessionID?: Session.ID }) => Effect.Effect<readonly Receipt[], unknown>
  /** Acknowledge restored permits, instructions and MCP for one recovered generation. */
  readonly ready: (input: { readonly run: RunRef }) => Effect.Effect<Receipt, unknown>
}
