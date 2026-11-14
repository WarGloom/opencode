export * as SubagentCompletion from "./subagent-completion.js"

import { Effect } from "effect"
import type { Job } from "../job.js"
import type { SessionBackground } from "./background.js"
import type { SessionMessage } from "./message.js"
import type { SessionSchema } from "./schema.js"

export const NO_TEXT = "Subagent completed without a text response."

export type RunningBackgroundItem = SessionBackground.OutstandingItem

/** A Session handle narrow enough for both Session.Service and SessionExecution to deliver a report. */
export interface SyntheticSession<E = never> {
  readonly report: (input: {
    readonly id?: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly text: string
    readonly description?: string
    readonly metadata?: SessionSchema.Metadata
  }) => Effect.Effect<unknown, E>
}

export function text(message: SessionMessage.Info | undefined) {
  if (message?.type !== "assistant") return NO_TEXT
  return (
    message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .filter((text) => text.length > 0)
      .join("\n\n") || NO_TEXT
  )
}

const clean = (value: string) => value.replace(/\s+/g, " ").trim()

/** Tells the sender which admitted prompts the child never read, so it can send them again. */
export function undelivered(prompts: ReadonlyArray<{ readonly id: string; readonly text: string }>): string {
  return [
    `Not delivered: the subagent ended before it read ${prompts.length === 1 ? "this prompt" : "these prompts"}. Send again if still needed.`,
    ...prompts.map((prompt) => `- ${prompt.id}: ${clean(prompt.text).slice(0, 160)}`),
  ].join("\n")
}

const STILL_RUNNING = "\n\nBackground work still running:\n"

export function formatBody(
  body: string,
  childSessionID: SessionSchema.ID,
  background?: ReadonlyArray<RunningBackgroundItem>,
): string {
  if (!background || background.length === 0) return body
  const lines = background.map((item) => {
    if (item.kind === "shell")
      return `- shell (${item.shellID}${item.sessionID !== childSessionID ? `, in ${item.sessionID}` : ""}): ${clean(item.command)}`
    if (item.kind === "image")
      return `- image (${item.model}${item.sessionID !== childSessionID ? `, in ${item.sessionID}` : ""}): ${item.path}`
    return `- subagent (${item.agent}, sessionID: ${item.childSessionID}): ${clean(item.description)}`
  })
  return `${body}${STILL_RUNNING}${lines.join("\n")}`
}

export const deliver = Effect.fnUntraced(function* <E>(
  sessions: SyntheticSession<E>,
  jobs: Pick<Job.Interface, "completeBackground">,
  input: Pick<Job.Info, "status" | "output" | "error" | "notificationID"> & {
    recovery: Extract<Job.Recovery, { kind: "subagent" }>
  },
) {
  if (input.status === "running") return
  const recovery = input.recovery
  if (recovery.completion === "none") {
    if (input.notificationID) yield* jobs.completeBackground(input.notificationID)
    return
  }
  const body =
    input.status === "completed"
      ? (input.output ?? NO_TEXT)
      : input.status === "error"
        ? (input.error ?? "Subagent failed")
        : (input.output ?? input.error ?? "Subagent cancelled")
  // Older rows lack the snapshot. Replay their recorded job status and preserve the full report body.
  const state = input.status === "completed" && recovery.outstanding?.length ? "running" : input.status
  const formatted = formatBody(body, recovery.childSessionID, recovery.outstanding)
  yield* sessions.report({
    ...(input.notificationID ? { id: input.notificationID } : {}),
    sessionID: recovery.parentSessionID,
    description: recovery.description,
    text: `<subagent sessionID="${recovery.childSessionID}" state="${state}" description="${recovery.description}">\n${formatted}\n</subagent>`,
    metadata: { source: "subagent", childID: recovery.childSessionID, agent: recovery.agent, state: input.status },
  })
  if (input.notificationID) yield* jobs.completeBackground(input.notificationID)
})
