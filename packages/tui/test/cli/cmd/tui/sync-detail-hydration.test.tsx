/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { directory, global, json, mount, observedJson, session, sessionID, wait } from "./sync-fixture"
test("live session deletion wins over stale hydration", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let requested = false
  let resolveSession!: (response: Response) => void
  const response = new Promise<Response>((resolve) => {
    resolveSession = resolve
  })
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) {
      requested = true
      return response
    }
    if (url.pathname === `/session/${sessionID}/message`) return json([])
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    sync.set("session", [session])
    sync.set("session_status", sessionID, { type: "busy" })
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(
      global({
        id: "evt_session_deleted_during_hydration",
        type: "session.deleted",
        properties: { sessionID, info: session },
      }),
    )
    resolveSession(json(session))
    await hydrate

    expect(sync.session.get(sessionID)).toBeUndefined()
    expect(sync.data.session_status[sessionID]).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("live detail, todo, diff, and move events win over stale hydration", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const stale = { ...session, directory, title: "stale", path: "old" }
  const updated = { ...stale, title: "live" }
  const liveTodo = [{ content: "live", status: "in_progress" as const, priority: "high" as const }]
  const staleTodo = [{ ...liveTodo[0], content: "stale" }]
  const liveDiff = [{ file: "live.ts", additions: 1, deletions: 0 }]
  const staleDiff = [{ file: "stale.ts", additions: 1, deletions: 0 }]
  let requested = false
  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(stale)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo`) return json(staleTodo)
    if (url.pathname === `/session/${sessionID}/diff`) return json(staleDiff)
    return undefined
  }, tmp.path)

  try {
    sync.set("session", [stale])
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(
      global({
        id: "evt_detail_live",
        type: "session.updated",
        properties: { sessionID, info: updated },
      }),
    )
    emit(
      global({
        id: "evt_todo_live",
        type: "todo.updated",
        properties: { sessionID, todos: liveTodo },
      }),
    )
    emit(
      global({
        id: "evt_diff_live",
        type: "session.diff",
        properties: { sessionID, diff: liveDiff },
      }),
    )
    emit(
      global({
        id: "evt_move_live",
        type: "session.next.moved",
        properties: {
          sessionID,
          location: { directory, workspaceID: "workspace_live" },
          subdirectory: "live/path",
          timestamp: 10,
        },
      }),
    )
    await wait(
      () =>
        sync.session.get(sessionID)?.path === "live/path" &&
        sync.data.todo[sessionID]?.[0]?.content === "live" &&
        sync.data.session_diff[sessionID]?.[0]?.file === "live.ts",
    )
    resolveMessages(json([]))
    await hydrate

    expect(sync.session.get(sessionID)).toMatchObject({
      title: "live",
      directory,
      path: "live/path",
      workspaceID: "workspace_live",
      time: { updated: 10 },
    })
    expect(sync.data.todo[sessionID]).toEqual(liveTodo)
    expect(sync.data.session_diff[sessionID]).toEqual(liveDiff)
  } finally {
    app.renderer.destroy()
  }
})

test("live detail, todo, diff, and move events before hydration beat stale responses", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const stale = { ...session, directory, title: "stale", path: "old" }
  const updated = { ...stale, title: "live" }
  const liveTodo = [{ id: "todo_pre", content: "live", status: "in_progress" as const, priority: "high" as const }]
  const staleTodo = [{ ...liveTodo[0], content: "stale" }]
  const liveDiff = [{ file: "live.ts", before: "", after: "live", additions: 1, deletions: 0 }]
  const staleDiff = [{ file: "stale.ts", before: "", after: "stale", additions: 1, deletions: 0 }]
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(stale)
    if (url.pathname === `/session/${sessionID}/message`) return json([])
    if (url.pathname === `/session/${sessionID}/todo`) return json(staleTodo)
    if (url.pathname === `/session/${sessionID}/diff`) return json(staleDiff)
    return undefined
  }, tmp.path)

  try {
    sync.set("session", [stale])
    emit(
      global({
        id: "evt_detail_before_hydration",
        type: "session.updated",
        properties: { sessionID, info: updated },
      }),
    )
    emit(
      global({
        id: "evt_todo_before_hydration",
        type: "todo.updated",
        properties: { sessionID, todos: liveTodo },
      }),
    )
    emit(
      global({
        id: "evt_diff_before_hydration",
        type: "session.diff",
        properties: { sessionID, diff: liveDiff },
      }),
    )
    emit(
      global({
        id: "evt_move_before_hydration",
        type: "session.next.moved",
        properties: {
          sessionID,
          location: { directory, workspaceID: "workspace_pre" },
          subdirectory: "pre/live",
          timestamp: 20,
        },
      }),
    )

    await wait(
      () =>
        sync.session.get(sessionID)?.path === "pre/live" &&
        sync.data.todo[sessionID]?.[0]?.content === "live" &&
        sync.data.session_diff[sessionID]?.[0]?.file === "live.ts",
    )

    await sync.session.sync(sessionID)

    expect(sync.session.get(sessionID)).toMatchObject({
      title: "live",
      path: "pre/live",
      workspaceID: "workspace_pre",
      time: { updated: 20 },
    })
    expect(sync.data.todo[sessionID]).toEqual(liveTodo)
    expect(sync.data.session_diff[sessionID]).toEqual(liveDiff)
  } finally {
    app.renderer.destroy()
  }
})

test("session updates after the detail response is consumed beat delayed hydration storage", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const stale = { ...session, directory, title: "stale" }
  const updated = { ...stale, title: "live" }
  let responseConsumed!: () => void
  const consumed = new Promise<void>((resolve) => {
    responseConsumed = resolve
  })
  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return observedJson(stale, responseConsumed)
    if (url.pathname === `/session/${sessionID}/message`) return messages
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    sync.set("session", [stale])
    const hydration = sync.session.sync(sessionID)
    await consumed
    emit(
      global({
        id: "evt_detail_after_response",
        type: "session.updated",
        properties: { sessionID, info: updated },
      }),
    )
    resolveMessages(json([]))
    await hydration

    expect(sync.session.get(sessionID)?.title).toBe("live")
  } finally {
    app.renderer.destroy()
  }
})
