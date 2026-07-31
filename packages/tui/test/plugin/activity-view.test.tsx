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

test("activity sidebar preserves team member identity while truncating its goal and navigates to each active session", async () => {
  // given
  const navigations: Array<{ readonly name: string; readonly sessionID?: string }> = []
  let parentMouseDowns = 0
  const api = {
    state: {
      activity: (): TuiActivity => ({
        sessions: [
          {
            id: "child-1",
            title: "secmvp-continuous-coordinator: Scan continuous security work across all active services",
            parentID: "root",
            agent: "sisyphus-junior",
            status: "busy",
          },
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
  }
  const app = await testRender(
    () => (
      <box width={42} paddingLeft={2} paddingRight={2}>
        <box paddingRight={1}>
          <box onMouseDown={() => parentMouseDowns++}>
            <Activity api={api} />
          </box>
        </box>
      </box>
    ),
    { width: 42, height: 6 },
  )

  try {
    await app.renderOnce()

    // when
    expect(app.captureCharFrame()).toContain("▼ Activity (2 sub · 1 task)")
    await app.mockMouse.click(2, 0)

    // then
    expect(app.captureCharFrame()).toContain("▶ Activity (2 sub · 1 task)")
    expect(app.captureCharFrame()).not.toContain("secmvp-continuous-coordinator")
    expect(app.captureCharFrame()).not.toContain("Review")

    // when
    await app.mockMouse.click(2, 0)
    parentMouseDowns = 0
    await app.mockMouse.click(2, 1)
    await app.mockMouse.click(2, 3)

    // then
    expect(app.captureCharFrame()).toContain("Activity (2 sub · 1 task)")
    const frame = app.captureCharFrame()
    const visibleRows = frame.split("\n").filter((row) => row.trim().length > 0)
    expect(visibleRows).toHaveLength(5)
    expect(frame).toContain("secmvp-continuous-coordinator: ...s")
    expect(frame).toContain("...")
    expect(frame).not.toContain("continuous security work")
    expect(frame).toContain("sisyphus-junior · Running")
    expect(app.captureCharFrame()).toContain("Review")
    expect(app.captureCharFrame()).toContain("oracle · Retrying")
    expect(navigations).toEqual([
      { name: "session", sessionID: "child-1" },
      { name: "session", sessionID: "child-2" },
    ])
    expect(parentMouseDowns).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})
