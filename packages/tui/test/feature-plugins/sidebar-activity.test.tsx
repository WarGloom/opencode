/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { SidebarActivity } from "../../src/feature-plugins/sidebar/activity"

type Session = { id: string; title?: string; parentID?: string; agent?: string; archived?: number }

function context(sessions: Session[], running: string[], tools: Record<string, string[]> = {}) {
  const color = RGBA.fromInts(200, 200, 200)
  return {
    theme: { text: { base: color, muted: color, feedback: { success: { base: color } } } },
    storage: { store: () => [{ open: true }, async () => {}] },
    ui: { router: { navigate: () => {} } },
    data: {
      session: {
        list: () => sessions.map((session) => ({ ...session, time: { archived: session.archived } })),
        status: (id: string) => (running.includes(id) ? "running" : "idle"),
        message: {
          list: (id: string) => [
            {
              type: "assistant",
              content: (tools[id] ?? []).map((name) => ({ type: "tool", name, state: { status: "running" } })),
            },
          ],
        },
      },
    },
  } as unknown as Context
}

async function frame(value: Context) {
  const app = await testRender(() => <SidebarActivity context={value} />, { width: 60, height: 10 })
  try {
    await app.renderOnce()
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

test("activity stays hidden while no session runs", async () => {
  expect(await frame(context([{ id: "a", title: "Idle work" }], []))).not.toContain("Activity")
})

test("activity lists running sessions with their agent and a summary", async () => {
  const value = context(
    [
      { id: "root", title: "V2 migration", agent: "Sisyphus - ultraworker" },
      { id: "child", title: "[quick] checks: run the gate", parentID: "root" },
      { id: "done", title: "Finished work" },
      { id: "old", title: "Archived work", archived: 1 },
    ],
    ["root", "child", "old"],
    { root: ["task", "shell"] },
  )

  const text = await frame(value)

  expect(text).toContain("Activity (1 agent · 1 sub · 1 task · 1 cmd)")
  expect(text).toContain("V2 migration")
  expect(text).toContain("Sisyphus - ultraworker · Running")
  expect(text).toContain("[quick] checks: run the gate")
  expect(text).toContain("Subagent · Running")
  expect(text).not.toContain("Finished work")
  expect(text).not.toContain("Archived work")
})
