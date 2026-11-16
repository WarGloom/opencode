export * as SubagentSteer from "./subagent-steer.js"

import type { SteerInput, SteerResult } from "@opencode/plugin/subagent"
import { Effect } from "effect"
import { Job } from "../job.js"
import { Session } from "../session.js"
import { SessionInbox } from "./inbox.js"
import { SubagentAdmission } from "./subagent-admission.js"
import { SubagentAdmissionStore } from "./subagent-admission-store.js"
import { SubagentJob } from "./subagent-job.js"
import { SubagentSteerBinding } from "./subagent-steer-binding.js"

export const make = Effect.gen(function* () {
  const admissions = yield* SubagentAdmissionStore.Service
  const authorization = yield* SubagentAdmission.Service
  const sessions = yield* Session.Service
  const inbox = yield* SessionInbox.Service
  const subagents = yield* SubagentJob.Service
  const jobs = yield* Job.Service

  return Effect.fn("SubagentAdmissionRun.steer")(function* (pluginID: string, input: SteerInput) {
    const requireOwner = Effect.gen(function* () {
      const entry = yield* admissions.get(pluginID, input.admissionID)
      if (entry === undefined || entry.childSessionID !== input.run.childSessionID || entry.generation !== input.run.generation)
        return yield* new SubagentAdmissionStore.Conflict({ admissionID: input.admissionID, reason: "Admission does not own generation" })
      return entry
    })
    const owner = yield* requireOwner
    const binding: SubagentSteerBinding.Binding = {
      pluginID,
      admissionID: owner.admissionID,
      parentSessionID: owner.parentSessionID,
      generation: input.run.generation,
      messageID: input.invocation.messageID,
      toolCallID: input.invocation.toolCallID,
    }
    const promptID = SubagentSteerBinding.promptID(binding)
    const reconcile = inbox.reconcile({ id: promptID, sessionID: owner.childSessionID, type: "user", delivery: "steer" })
    const publish = (admit: Effect.Effect<unknown, unknown>) => admissions.serialized(Effect.gen(function* (): Effect.fn.Return<SteerResult, unknown> {
      const entry = yield* requireOwner
      yield* authorization.steer(entry, input.invocation, false)
      const existing = yield* reconcile
      const recovery = entry.start === undefined ? undefined : {
        kind: "subagent" as const,
        parentSessionID: entry.parentSessionID,
        childSessionID: entry.childSessionID,
        agent: entry.agent,
        description: entry.description,
        pluginID,
        admissionID: entry.admissionID,
        generation: input.run.generation,
        completion: entry.start.completion,
      }
      const joined = recovery !== undefined && entry.status === "running"
        ? yield* subagents.join(recovery, promptID, existing === undefined ? admit.pipe(Effect.asVoid) : Effect.void)
        : false
      if (existing !== undefined || joined) return { kind: "joined-existing-run", run: input.run, promptID }
      return { kind: "closed-before-admission" }
    }).pipe(Effect.uninterruptible))
    const preflight = yield* admissions.serialized(Effect.gen(function* () {
      const entry = yield* requireOwner
      yield* authorization.steer(entry, input.invocation, false)
      if ((yield* reconcile) !== undefined) return "replay" as const
      const job = yield* jobs.get(entry.childSessionID)
      return entry.status === "running" && entry.start !== undefined && job?.status === "running" && job.generation === input.run.generation
        ? "open" as const : "closed" as const
    }))
    switch (preflight) {
      case "replay":
        return yield* publish(Effect.void)
      case "closed":
        return { kind: "closed-before-admission" as const }
      case "open":
        yield* authorization.steer(owner, input.invocation, true)
        return yield* sessions.withPreparedPrompt({ ...input.prompt, sessionID: owner.childSessionID, id: promptID, metadata: input.metadata, delivery: "steer", resume: false },
          (prepared) => publish(prepared.publish({ delivery: "steer", metadata: { opencodeSubagentSteer: binding } })))
    }
  })
})
