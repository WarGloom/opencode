/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { SidebarActivity } from "../../src/feature-plugins/sidebar/activity"
import { createStore } from "solid-js/store"

type Session = {
  id: string
  title?: string
  parentID?: string
  agent?: string
  archived?: number
  projectID?: string
}

function context(
  sessions: Session[],
  running: string[],
  tools: Record<string, string[]> = {},
  view: { open: boolean; workspace?: boolean } = { open: true },
) {
  const color = RGBA.fromInts(200, 200, 200)
  const byID = new Map(sessions.map((session) => [session.id, { ...session, projectID: session.projectID ?? "p1" }]))
  const root = (id: string): string => {
    const parent = byID.get(id)?.parentID
    return parent ? root(parent) : id
  }
  return {
    theme: { text: { base: color, muted: color, feedback: { success: { base: color } } } },
    storage: { store: () => [view, async () => {}] },
    ui: { router: { navigate: () => {} } },
    data: {
      session: {
        list: () => [...byID.values()].map((session) => ({ ...session, time: { archived: session.archived } })),
        get: (id: string) => byID.get(id),
        root,
        family: (id: string) => [...byID.keys()].filter((item) => root(item) === root(id)),
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

async function frame(value: Context, sessionID: string) {
  const app = await testRender(() => <SidebarActivity context={value} sessionID={sessionID} />, {
    width: 60,
    height: 14,
  })
  try {
    await app.renderOnce()
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

const sessions: Session[] = [
  { id: "root", title: "V2 migration", agent: "Sisyphus - ultraworker" },
  { id: "child", title: "[quick] checks: run the gate", parentID: "root" },
  { id: "done", title: "Finished work" },
  { id: "old", title: "Archived work", archived: 1 },
  { id: "peer", title: "Other session in this project", agent: "Atlas" },
  { id: "peer-child", title: "Peer subagent", parentID: "peer" },
  { id: "elsewhere", title: "Session in another project", projectID: "p2" },
]
const running = ["root", "child", "old", "peer", "peer-child", "elsewhere"]

test("activity stays hidden while nothing in the project runs", async () => {
  expect(await frame(context(sessions, ["elsewhere"]), "done")).not.toContain("Activity")
})

test("activity lists the shown session's family and folds the rest of the project", async () => {
  const text = await frame(context(sessions, running, { root: ["task", "shell"] }), "child")

  expect(text).toContain("Activity (1 agent · 1 sub · 1 task · 1 cmd)")
  expect(text).toContain("V2 migration")
  expect(text).toContain("Sisyphus - ultraworker · Running")
  expect(text).toContain("[quick] checks: run the gate")
  expect(text).toContain("▶ Workspace (1 agent · 1 sub)")
  expect(text).not.toContain("Other session in this project")
  expect(text).not.toContain("Session in another project")
  expect(text).not.toContain("Finished work")
  expect(text).not.toContain("Archived work")
})

test("an expanded workspace lists the other running sessions of the same project only", async () => {
  const text = await frame(context(sessions, running, {}, { open: true, workspace: true }), "root")

  expect(text).toContain("▼ Workspace (1 agent · 1 sub)")
  expect(text).toContain("Other session in this project")
  expect(text).toContain("Atlas · Running")
  expect(text).toContain("Peer subagent")
  expect(text).not.toContain("Session in another project")
})

test("an idle session still shows the workspace toggle when its project is busy", async () => {
  const text = await frame(context(sessions, ["peer"]), "done")

  expect(text).toContain("Activity")
  expect(text).not.toContain("Activity (")
  expect(text).toContain("▶ Workspace (1 agent)")
})

test.each([
  { change: "start", summary: "1 agent · 1 sub · 2 tasks · 1 cmd", workspace: "1 agent · 1 cmd" },
  { change: "end", summary: "1 agent · 1 sub · 1 cmd", workspace: "1 agent · 1 cmd" },
  { change: "append", summary: "1 agent · 1 sub · 2 tasks · 1 cmd", workspace: "1 agent · 1 cmd" },
  { change: "remove", summary: "1 agent · 1 sub · 1 cmd", workspace: "1 agent · 1 cmd" },
  { change: "replace", summary: "1 agent · 1 sub · 2 tasks · 2 cmds", workspace: "1 agent · 1 cmd" },
  { change: "rename", summary: "1 agent · 1 sub · 2 tasks", workspace: "1 agent · 1 cmd" },
  { change: "leave", summary: "1 agent · 1 task", workspace: "1 agent · 1 cmd" },
  { change: "join", summary: "1 agent · 1 sub · 1 task · 1 cmd", workspace: "1 agent · 1 cmd" },
  { change: "workspace-remove", summary: "1 agent · 1 sub · 1 task · 1 cmd", workspace: "1 agent" },
] as const)("activity updates $change without revisiting unchanged resident history", async (item) => {
  let reads = 0
  const tool = (name: string, status: "running" | "streaming" | "completed" = "running") => ({
    type: "assistant" as const,
    content: [{ type: "tool" as const, name, state: { status } }],
  })
  const historical = () => Array.from({ length: 2_000 }, (): ReturnType<typeof tool> => {
    const content = tool("read", "completed").content
    return {
      type: "assistant",
      get content() {
        reads++
        return content
      },
    }
  })
  const [messages, updateMessages] = createStore({
    root: [...historical(), tool("task"), tool("task", "streaming")],
    child: [tool("shell")],
    peer: [...historical(), tool("shell")],
  })
  const [active, updateActive] = createStore(item.change === "join" ? ["root", "peer"] : ["root", "child", "peer"])
  const value = context(sessions, active)
  const histories = new Map([
    ["root", () => messages.root],
    ["child", () => messages.child],
    ["peer", () => messages.peer],
  ])
  Object.assign(value.data.session.message, {
    list: (id: string) => histories.get(id)?.() ?? [],
  })
  await using app = await testRender(() => <SidebarActivity context={value} sessionID="root" />, { width: 80, height: 20 })
  await app.renderOnce()
  expect(app.captureCharFrame()).toContain(item.change === "join" ? "Activity (1 agent · 1 task)" : "Activity (1 agent · 1 sub · 1 task · 1 cmd)")
  expect(app.captureCharFrame()).toContain("▶ Workspace (1 agent · 1 cmd)")
  reads = 0

  switch (item.change) {
    case "start": updateMessages("root", 2_001, "content", 0, "state", "status", "running"); break
    case "end": updateMessages("root", 2_000, "content", 0, "state", "status", "completed"); break
    case "append": updateMessages("root", 2_001, "content", (parts) => [...parts, ...tool("task").content]); break
    case "remove": updateMessages("root", (rows) => rows.filter((_, index) => index !== 2_000)); break
    case "replace": updateMessages("root", 2_001, "content", [...tool("task").content, ...tool("shell").content]); break
    case "rename": updateMessages("child", 0, "content", 0, "name", "task"); break
    case "leave": updateActive(["root", "peer"]); break
    case "join": updateActive(["root", "child", "peer"]); break
    case "workspace-remove": updateMessages("peer", (rows) => rows.slice(0, -1)); break
    default: item satisfies never
  }
  await app.renderOnce()
  expect(app.captureCharFrame()).toContain(`Activity (${item.summary})`)
  expect(app.captureCharFrame()).toContain(`▶ Workspace (${item.workspace})`)
  if (item.change !== "leave" && item.change !== "join") expect(reads).toBe(0)
  app.renderer.destroy()
  reads = 0
  updateMessages("root", 2_000, "content", [])
  expect(reads).toBe(0)
})
