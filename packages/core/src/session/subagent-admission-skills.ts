export * as SubagentAdmissionSkills from "./subagent-admission-skills.js"

import type { AcceptSkillsInput } from "@opencode/plugin/subagent"
import { Skill } from "@opencode/schema/skill"
import { Hash } from "@opencode/util/hash"
import { Effect } from "effect"
import { isDeepStrictEqual } from "node:util"
import { Session } from "../session.js"
import { SubagentAdmission } from "./subagent-admission.js"
import { SubagentAdmissionStore } from "./subagent-admission-store.js"

// Delegated skills are accepted for the prepared child under the parent's authority, derived only from the journal.
export const make = Effect.gen(function* () {
  const admissions = yield* SubagentAdmissionStore.Service
  const sessions = yield* Session.Service
  return Effect.fn("SubagentAdmissionSkills.accept")(function* (pluginID: string, input: AcceptSkillsInput) {
    const entry = yield* admissions.get(pluginID, input.admissionID)
    if (entry === undefined || entry.revoked === true)
      return yield* new SubagentAdmissionStore.Conflict({ admissionID: input.admissionID, reason: "Unknown or revoked admission" })
    const skills = {
      promptID: input.promptID ?? entry.skills?.promptID ?? entry.start?.promptID ?? SubagentAdmission.promptID(pluginID, input.admissionID),
      selections: input.skills.map((selection, index) => ({
        activationID: Skill.ActivationID.make(`ska_${Hash.sha256(JSON.stringify([pluginID, input.admissionID, index, selection.skill, selection.arguments ?? null])).slice(0, 32)}`),
        skill: selection.skill,
        ...(selection.arguments === undefined ? {} : { arguments: selection.arguments }),
      })),
    }
    if (skills.selections.length === 0) return []
    // Persist the ordered request before any activation; a changed retry never reaches the native owner.
    const bound = yield* admissions.serialized(Effect.gen(function* () {
      const latest = yield* admissions.get(pluginID, input.admissionID)
      if (latest?.skills !== undefined) {
        if (!isDeepStrictEqual(latest.skills, skills))
          return yield* new SubagentAdmissionStore.Conflict({ admissionID: input.admissionID, reason: "Skill batch changed" })
        return latest
      }
      if (latest?.status !== "prepared")
        return yield* new SubagentAdmissionStore.Conflict({ admissionID: input.admissionID, reason: "Skills require a prepared admission" })
      const updated = { ...latest, skills }
      yield* admissions.put(updated)
      return updated
    }))
    const parent = yield* sessions.get(bound.parentSessionID)
    // Cancellation interrupts a pending skill permission through the shared authorization waiter.
    const result = yield* admissions.authorize(bound, sessions.acceptSkills({
      sessionID: bound.childSessionID,
      authorization: { session: parent, agent: bound.invocation.agent },
      promptID: skills.promptID,
      items: skills.selections,
    }).pipe(Effect.as(SubagentAdmission.receipt(bound))), "skills")
    if (result.status === "cancelled")
      return yield* new SubagentAdmissionStore.Conflict({ admissionID: input.admissionID, reason: "Admission cancelled" })
    const accepted = yield* sessions.skillActivations({ sessionID: bound.childSessionID })
    return skills.selections.flatMap((selection) => accepted.filter((activation) => activation.activationID === selection.activationID))
  })
})
