/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { TuiActivity } from "@opencode-ai/plugin/tui"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { Activity } from "../../src/feature-plugins/sidebar/activity"
import { createBuiltinPlugins } from "../../src/feature-plugins/builtins"

const color = RGBA.fromInts(200, 200, 200)

test("activity registers as a session sidebar section", () => {
  // given
  const plugins = createBuiltinPlugins({ experimentalEventSystem: false })

  // when
  const ids = plugins.map((plugin) => plugin.id)

  // then
  expect(ids).toContain("internal:sidebar-activity")
})

test("activity sidebar folds two sessions, preserves its summary, and navigates rows", async () => {
  // given
  const navigations: Array<{ readonly name: string; readonly sessionID?: string }> = []
  let parentMouseDowns = 0
  const api = {
    state: {
      activity: (): TuiActivity => ({
        sessions: [
          { id: "child-1", title: "Investigation", parentID: "root", agent: "explore", status: "busy" },
          { id: "child-2", title: "Review", parentID: "root", agent: "oracle", status: "retry" },
        ],
        agents: 0,
        subagents: 2,
        tasks: 1,
        commands: 0,
      }),
    },
    theme: { current: { text: color, textMuted: color, success: color, warning: color } },
    route: {
      navigate(name: string, params?: Record<string, unknown>) {
        navigations.push({ name, ...(typeof params?.sessionID === "string" ? { sessionID: params.sessionID } : {}) })
      },
    },
  } as const
  const app = await testRender(
    () => (
      <box onMouseDown={() => parentMouseDowns++}>
        <Activity api={api} />
      </box>
    ),
    { width: 60, height: 4 },
  )

  try {
    await app.renderOnce()

    // when
    await app.mockMouse.click(0, 0)

    // then
    expect(app.captureCharFrame()).toContain("▶ Activity (2 sub · 1 task)")
    expect(app.captureCharFrame()).not.toContain("explore Investigation · Running")
    expect(app.captureCharFrame()).not.toContain("oracle Review · Retrying")

    // when
    await app.mockMouse.click(0, 0)

    // then
    expect(app.captureCharFrame()).toContain("▼ Activity (2 sub · 1 task)")
    expect(app.captureCharFrame()).toContain("explore Investigation · Running")
    expect(app.captureCharFrame()).toContain("oracle Review · Retrying")

    // when
    parentMouseDowns = 0
    await app.mockMouse.click(2, 1)
    await app.mockMouse.click(2, 2)

    // then
    expect(navigations).toEqual([
      { name: "session", sessionID: "child-1" },
      { name: "session", sessionID: "child-2" },
    ])
    expect(parentMouseDowns).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("activity sidebar folds and reopens three sessions", async () => {
  // given
  const api = {
    state: {
      activity: (): TuiActivity => ({
        sessions: [
          { id: "agent-1", title: "Plan", agent: "prometheus", status: "busy" },
          { id: "agent-2", title: "Implement", agent: "sisyphus", status: "busy" },
          { id: "agent-3", title: "Review", agent: "oracle", status: "retry" },
        ],
        agents: 3,
        subagents: 0,
        tasks: 0,
        commands: 0,
      }),
    },
    theme: { current: { text: color, textMuted: color, success: color, warning: color } },
    route: { navigate() {} },
  } as const
  const app = await testRender(() => <Activity api={api} />, { width: 60, height: 4 })

  try {
    await app.renderOnce()

    // when
    await app.mockMouse.click(0, 0)

    // then
    expect(app.captureCharFrame()).toContain("▶ Activity (3 agents)")
    expect(app.captureCharFrame()).not.toContain("prometheus Plan · Running")
    expect(app.captureCharFrame()).not.toContain("sisyphus Implement · Running")
    expect(app.captureCharFrame()).not.toContain("oracle Review · Retrying")

    // when
    await app.mockMouse.click(0, 0)

    // then
    expect(app.captureCharFrame()).toContain("▼ Activity (3 agents)")
    expect(app.captureCharFrame()).toContain("prometheus Plan · Running")
    expect(app.captureCharFrame()).toContain("sisyphus Implement · Running")
    expect(app.captureCharFrame()).toContain("oracle Review · Retrying")
  } finally {
    app.renderer.destroy()
  }
})
