import type { Agent } from "@opencode/schema/agent"
import type { Command } from "@opencode/schema/command"
import type { Location } from "@opencode/schema/location"
import type { Model } from "@opencode/schema/model"
import type { Permission } from "@opencode/schema/permission"
import type { PromptInput } from "@opencode/schema/prompt-input"
import type { Session } from "@opencode/schema/session"
import type { SessionInbox } from "@opencode/schema/session-inbox"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { Skill } from "@opencode/schema/skill"

/** Experimental: may change without compatibility guarantees. */
export interface RunRef {
  readonly childSessionID: Session.ID
  readonly generation: string
}

export type Invocation = {
  readonly agent: Agent.ID
} & (
  | {
      readonly kind: "tool"
      readonly messageID: SessionMessage.ID
      readonly toolCallID: string
      /** Set only by an authentic team_create or team_add_member tool call; anchors later team generations. */
      readonly team?: { readonly teamRunID: string; readonly member: string }
    }
  | { readonly kind: "command"; readonly invocationID: Command.InvocationID; readonly command: string }
  | {
      readonly kind: "team"
      readonly invocationID: string
      readonly teamRunID: string
      readonly member: string
      /** Admission ID of the unrevoked tool-anchored provisioning admission for this member. */
      readonly provisioningAdmissionID: string
    }
)

export interface PrepareInput {
  readonly admissionID: string
  readonly parentSessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly maxDepth: number
  readonly description: string
  readonly invocation: Invocation
  readonly target:
    | {
        readonly kind: "create"
        readonly sessionID?: Session.ID
        readonly location?: Location.Ref
        readonly permissions?: Permission.Ruleset
      }
    | { readonly kind: "existing"; readonly sessionID: Session.ID }
}

export interface StartInput {
  readonly admissionID: string
  readonly promptID?: SessionMessage.ID
  readonly prompt: PromptInput.Prompt
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly delivery: SessionInbox.Delivery
  readonly mode: "foreground" | "background"
  readonly completion: "parent" | "none"
}

/** Accept a whole batch of child skills after prepare and before start. */
export interface AcceptSkillsInput {
  readonly admissionID: string
  /** Child prompt message the snapshots bind to. Defaults to the prepared receipt's promptID; start must use the same ID. */
  readonly promptID?: SessionMessage.ID
  readonly skills: readonly { readonly skill: Skill.ID; readonly arguments?: string }[]
}

export type Target = { readonly admissionID: string } | { readonly run: RunRef }

export interface Receipt {
  readonly admissionID: string
  readonly parentSessionID: Session.ID
  readonly childSessionID: Session.ID
  readonly status: "authorizing" | "prepared" | "accepted" | "running" | "completed" | "error" | "cancelled"
  readonly run?: RunRef
  readonly promptID?: SessionMessage.ID
  readonly completion?: "parent" | "none"
  readonly output?: string
  readonly outputModel?: Model.Ref
  readonly error?: string
  /** Set on a revoked team provisioning anchor. Status, output and error keep their historical values. */
  readonly revoked?: true
}

export interface WaitInput {
  readonly run: RunRef
  readonly timeout?: number
}

export interface WaitResult {
  readonly receipt: Receipt
  readonly timedOut: boolean
}
