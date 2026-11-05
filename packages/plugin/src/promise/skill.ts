import type { SkillApi } from "@opencode/client/promise/api"
import type { Skill } from "@opencode/schema/skill"
import type { Types } from "effect"
import type { Transform } from "./registration.js"
import type { Hooks } from "./registration.js"
export type { SkillActivation, SkillActivationSource, SkillHooks } from "../effect/skill.js"
import type { SkillHooks } from "../effect/skill.js"
import type { SkillActivationInput } from "../effect/skill.js"
import type { Session } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"
export type { SkillActivationInput } from "../effect/skill.js"

export interface SkillEditor {
  list(): readonly Types.DeepMutable<Skill.Info>[]
  get(id: string): Types.DeepMutable<Skill.Info> | undefined
  add(skill: Skill.Info): void
  update(id: string, update: (skill: Types.DeepMutable<Skill.Info>) => void): void
  remove(id: string): void
}

export interface SkillDomain extends SkillApi {
  readonly hook: Hooks<SkillHooks>
  readonly transform: Transform<SkillEditor>
  readonly reload: () => Promise<void>
}

export interface ExperimentalSkillDomain {
  readonly activate: (input: SkillActivationInput) => Promise<SessionMessage.SkillActivation>
  readonly activations: (input: { readonly sessionID: Session.ID }) => Promise<readonly SessionMessage.SkillActivation[]>
  readonly activation: (input: { readonly sessionID: Session.ID; readonly skillID: Skill.ID }) => Promise<SessionMessage.SkillActivation>
}
