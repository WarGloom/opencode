export type TaskSessionCandidate = {
  id: string
  parentID?: string
  title?: string
  time: {
    created: number
  }
}

const TASK_SESSION_START_SKEW_MS = 5_000

export function resolveTaskSessionID(input: {
  metadataSessionID?: unknown
  parentSessionID: string
  description?: unknown
  subagentType?: unknown
  startedAt?: number
  sessions: readonly TaskSessionCandidate[]
}): string | undefined {
  const metadataSessionID = typeof input.metadataSessionID === "string" && input.metadataSessionID
    ? input.metadataSessionID
    : undefined

  if (typeof input.description !== "string" || !input.description) {
    return metadataSessionID
  }

  const description = input.description
  const normalizedSubagentType = typeof input.subagentType === "string" ? input.subagentType.toLowerCase() : undefined
  const matches = input.sessions.filter((child) => {
    if (child.parentID !== input.parentSessionID) return false
    const title = child.title ?? ""
    if (!title.includes(description)) return false
    if (!normalizedSubagentType) return true
    return title.toLowerCase().includes(normalizedSubagentType)
  })

  if (!matches.length) return metadataSessionID
  if (input.startedAt === undefined) {
    return metadataSessionID ?? matches.toSorted((a, b) => b.time.created - a.time.created)[0]?.id
  }

  const startedAt = input.startedAt
  const newestStartedAttempt = matches
    .filter((child) => child.time.created >= startedAt - TASK_SESSION_START_SKEW_MS)
    .toSorted((a, b) => b.time.created - a.time.created)[0]
  if (!metadataSessionID) {
    return newestStartedAttempt?.id
      ?? matches.toSorted((a, b) => Math.abs(a.time.created - startedAt) - Math.abs(b.time.created - startedAt))[0]?.id
  }

  const metadataCandidate = matches.find((child) => child.id === metadataSessionID)
  if (!metadataCandidate) return newestStartedAttempt?.id ?? metadataSessionID
  if (newestStartedAttempt && newestStartedAttempt.time.created > metadataCandidate.time.created) {
    return newestStartedAttempt.id
  }

  return metadataSessionID
}
