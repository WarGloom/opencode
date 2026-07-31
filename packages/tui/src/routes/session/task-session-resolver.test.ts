import { describe, expect, it } from "bun:test"
import { resolveTaskSessionID, type TaskSessionCandidate } from "./task-session-resolver"

const sessions: TaskSessionCandidate[] = [
  { id: "ses_parent", title: "Parent", time: { created: 100 } },
  { id: "ses_first", parentID: "ses_parent", title: "inspect cache (@Explore subagent)", time: { created: 200 } },
  { id: "ses_second", parentID: "ses_parent", title: "inspect cache (@Oracle subagent)", time: { created: 400 } },
  { id: "ses_other_parent", parentID: "ses_else", title: "inspect cache (@Explore subagent)", time: { created: 300 } },
]

describe("resolveTaskSessionID", () => {
  it("uses metadata session id when present", () => {
    const result = resolveTaskSessionID({
      metadataSessionID: "ses_metadata",
      parentSessionID: "ses_parent",
      description: "inspect cache",
      sessions,
    })

    expect(result).toBe("ses_metadata")
  })

  it("uses newer matching child over stale metadata after retry", () => {
    const result = resolveTaskSessionID({
      metadataSessionID: "ses_first",
      parentSessionID: "ses_parent",
      description: "inspect cache",
      subagentType: "explore",
      startedAt: 195,
      sessions: [
        ...sessions,
        { id: "ses_retry", parentID: "ses_parent", title: "inspect cache (@Explore subagent)", time: { created: 600 } },
      ],
    })

    expect(result).toBe("ses_retry")
  })

  it("falls back to matching child title and subagent", () => {
    const result = resolveTaskSessionID({
      parentSessionID: "ses_parent",
      description: "inspect cache",
      subagentType: "explore",
      sessions,
    })

    expect(result).toBe("ses_first")
  })

  it("chooses the child created nearest to the task start when duplicate titles exist", () => {
    const result = resolveTaskSessionID({
      parentSessionID: "ses_parent",
      description: "inspect cache",
      startedAt: 390,
      sessions,
    })

    expect(result).toBe("ses_second")
  })

  it("returns undefined when no child session matches", () => {
    const result = resolveTaskSessionID({
      parentSessionID: "ses_parent",
      description: "missing task",
      sessions,
    })

    expect(result).toBeUndefined()
  })
})
