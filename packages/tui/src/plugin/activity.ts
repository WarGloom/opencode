import type { TuiActivity } from "@opencode-ai/plugin/tui"

type ActivitySession = {
  readonly id: string
  readonly title: string
  readonly parentID?: string
}

type ActivityStatus = {
  readonly type: "idle" | "busy" | "retry"
}

type ActivityMessage = {
  readonly sessionID: string
  readonly role: string
  readonly agent?: string
}

type ActivityPart = {
  readonly sessionID: string
  readonly type: string
  readonly tool?: string
  readonly state?: {
    readonly status: string
  }
  readonly metadata?: {
    readonly sessionId?: string
  }
}

type ActivityInput = {
  readonly sessions: ReadonlyArray<ActivitySession>
  readonly statuses: Readonly<Record<string, ActivityStatus | undefined>>
  readonly messages: Readonly<Record<string, ReadonlyArray<ActivityMessage> | undefined>>
  readonly parts: ReadonlyArray<ActivityPart>
}

export function createActivity(input: ActivityInput): TuiActivity {
  const runningTaskSessions = new Set(
    input.parts.flatMap((part) =>
      part.type === "tool" && part.tool === "task" && part.state?.status === "running" && part.metadata?.sessionId
        ? [part.metadata.sessionId]
        : [],
    ),
  )
  const sessions = input.sessions.flatMap((session) => {
    const status = input.statuses[session.id]
    if ((!status || status.type === "idle") && !runningTaskSessions.has(session.id)) return []
    const message = input.messages[session.id]?.findLast((item) => item.role === "user")

    return [
      {
        id: session.id,
        title: session.title,
        status: status && status.type !== "idle" ? status.type : "busy",
        ...(session.parentID ? { parentID: session.parentID } : {}),
        ...(message?.agent ? { agent: message.agent } : {}),
      },
    ]
  })
  const active = new Set(sessions.map((session) => session.id))
  const running = input.parts.filter(
    (part) => active.has(part.sessionID) && part.type === "tool" && part.state?.status === "running",
  )

  return {
    sessions,
    agents: sessions.filter((session) => !session.parentID).length,
    subagents: sessions.filter((session) => session.parentID).length,
    tasks: running.filter((part) => part.tool === "task").length,
    commands: running.filter((part) => part.tool === "bash" || part.tool === "interactive_bash").length,
  }
}
