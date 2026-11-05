import type { Session } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { AcceptSkillsInput, PrepareInput, Receipt, RunRef, StartInput, Target, WaitInput, WaitResult } from "../subagent.js"

/** Native, plugin-scoped subagent admission. Experimental. */
export interface SubagentDomain {
  readonly prepare: (input: PrepareInput, options?: { readonly signal?: AbortSignal }) => Promise<Receipt>
  readonly acceptSkills: (input: AcceptSkillsInput, options?: { readonly signal?: AbortSignal }) => Promise<readonly SessionMessage.SkillActivation[]>
  readonly start: (input: StartInput, options?: { readonly signal?: AbortSignal }) => Promise<Receipt>
  readonly get: (input: Target) => Promise<Receipt | undefined>
  readonly wait: (input: WaitInput) => Promise<WaitResult>
  readonly cancel: (input: Target) => Promise<Receipt>
  readonly reconcile: (input?: { readonly parentSessionID?: Session.ID }) => Promise<readonly Receipt[]>
  /** Call only after restoring occupied permits and child instructions/MCP. */
  readonly ready: (input: { readonly run: RunRef }) => Promise<Receipt>
}
