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

test("activity sidebar navigates to each active session", async () => {
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
    await app.mockMouse.click(2, 1)
    await app.mockMouse.click(2, 2)

    // then
    expect(app.captureCharFrame()).toContain("Activity (2 sub · 1 task)")
    expect(app.captureCharFrame()).toContain("explore Investigation · Running")
    expect(app.captureCharFrame()).toContain("oracle Review · Retrying")
    expect(navigations).toEqual([
      { name: "session", sessionID: "child-1" },
      { name: "session", sessionID: "child-2" },
    ])
    expect(parentMouseDowns).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})
