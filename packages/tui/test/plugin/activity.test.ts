import { describe, expect, test } from "bun:test"
import { createActivity } from "../../src/plugin/activity"

describe("createActivity", () => {
  test("counts active agents, subagents, tasks, and commands", () => {
    // given
    const input = {
      sessions: [
        { id: "root", title: "Main session" },
        { id: "child", title: "Background investigation", parentID: "root" },
        { id: "idle", title: "Finished session", parentID: "root" },
      ],
      statuses: {
        root: { type: "busy" },
        child: { type: "retry" },
        idle: { type: "idle" },
      },
      messages: {
        root: [{ sessionID: "root", role: "user", agent: "sisyphus" }],
        child: [{ sessionID: "child", role: "user", agent: "explore" }],
      },
      parts: [
        { sessionID: "root", type: "tool", tool: "task", state: { status: "running" } },
        { sessionID: "root", type: "tool", tool: "bash", state: { status: "running" } },
        { sessionID: "child", type: "tool", tool: "interactive_bash", state: { status: "running" } },
        { sessionID: "child", type: "tool", tool: "read", state: { status: "running" } },
        { sessionID: "root", type: "tool", tool: "task", state: { status: "completed" } },
        { sessionID: "idle", type: "tool", tool: "task", state: { status: "running" } },
        { sessionID: "unknown", type: "tool", tool: "bash", state: { status: "running" } },
        { sessionID: "root", type: "text" },
      ],
    } as const

    // when
    const result = createActivity(input)

    // then
    expect(result).toEqual({
      sessions: [
        { id: "root", title: "Main session", status: "busy", agent: "sisyphus" },
        {
          id: "child",
          title: "Background investigation",
          parentID: "root",
          status: "retry",
          agent: "explore",
        },
      ],
      agents: 1,
      subagents: 1,
      tasks: 1,
      commands: 2,
    })
  })

  test("returns no activity when all sessions and tools are idle", () => {
    // given
    const input = {
      sessions: [{ id: "idle", title: "Finished session" }],
      statuses: { idle: { type: "idle" } },
      messages: {},
      parts: [{ sessionID: "idle", type: "tool", tool: "bash", state: { status: "completed" } }],
    } as const

    // when
    const result = createActivity(input)

    // then
    expect(result).toEqual({ sessions: [], agents: 0, subagents: 0, tasks: 0, commands: 0 })
  })

  test("includes a background child while its parent task tool is running", () => {
    // given
    const input = {
      sessions: [
        { id: "root", title: "Main session" },
        { id: "child", title: "30-second sleep test", parentID: "root" },
      ],
      statuses: { root: { type: "busy" } },
      messages: {
        child: [{ sessionID: "child", role: "user", agent: "explore" }],
      },
      parts: [
        {
          sessionID: "root",
          type: "tool",
          tool: "task",
          state: { status: "running" },
          metadata: { sessionId: "child", background: true },
        },
      ],
    } as const

    // when
    const result = createActivity(input)

    // then
    expect(result.sessions).toContainEqual({
      id: "child",
      title: "30-second sleep test",
      parentID: "root",
      status: "busy",
      agent: "explore",
    })
    expect(result.subagents).toBe(1)
  })
})
