import type { SkillApi } from "@opencode/client/effect/api"
import { Skill } from "@opencode/schema/skill"
import type { Agent } from "@opencode/schema/agent"
import type { Session } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { Effect, Schema, Types } from "effect"
import type { Hooks, Transform } from "./registration.js"

export type SkillActivationSource =
  | { readonly kind: "session"; readonly messageID: SessionMessage.ID }
  | { readonly kind: "prompt"; readonly messageID: SessionMessage.ID; readonly selectionIndex: number }
  | { readonly kind: "tool"; readonly messageID: SessionMessage.ID; readonly callID: string }

export interface SkillActivation {
  readonly activationID: string
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly source: SkillActivationSource
  readonly skill: Skill.Info
  readonly arguments?: string
  content: string
  metadata: Record<string, Schema.Json>
  decision: { readonly allow: true } | { readonly allow: false; readonly reason: string }
}

export interface SkillHooks {
  readonly "experimental.activate": SkillActivation
}

export interface SkillEditor {
  list(): readonly Types.DeepMutable<Skill.Info>[]
  get(id: string): Types.DeepMutable<Skill.Info> | undefined
  add(skill: Skill.Info): void
  update(id: string, update: (skill: Types.DeepMutable<Skill.Info>) => void): void
  remove(id: string): void
}

export interface SkillDomain extends SkillApi<unknown> {
  readonly hook: Hooks<SkillHooks>
  readonly transform: Transform<SkillEditor>
  readonly reload: () => Effect.Effect<void>
}

export interface SkillActivationInput {
  readonly sessionID: Session.ID
  readonly activationID?: Skill.ActivationID
  readonly messageID?: SessionMessage.ID
  readonly skill: Skill.ID
  readonly arguments?: string
  readonly resume?: boolean
}

export interface ExperimentalSkillDomain {
  readonly activate: (input: SkillActivationInput) => Effect.Effect<SessionMessage.SkillActivation, unknown>
  readonly activations: (input: { readonly sessionID: Session.ID }) => Effect.Effect<readonly SessionMessage.SkillActivation[], unknown>
  readonly activation: (input: { readonly sessionID: Session.ID; readonly skillID: Skill.ID }) => Effect.Effect<SessionMessage.SkillActivation, unknown>
}
