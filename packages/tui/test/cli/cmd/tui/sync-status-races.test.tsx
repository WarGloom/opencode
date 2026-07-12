/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { directory, global, json, mount, session, sessionID, wait } from "./sync-fixture"
test("out-of-scope session events do not enter the filtered view", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const created = { ...session, id: "ses_out_of_scope", directory: "/tmp/other" }
  const { app, emit, kv, sync } = await mount(() => undefined, tmp.path)

  try {
    emit({
      directory: "/tmp/other",
      project: "proj_test",
      payload: {
        id: "evt_out_of_scope",
        type: "session.created",
        properties: { sessionID: created.id, info: created },
      },
    })

    expect(sync.session.get(created.id)).toBeUndefined()
    kv.set("session_directory_filter_enabled", false)
    emit({
      directory,
      project: "proj_other",
      payload: {
        id: "evt_other_project",
        type: "session.created",
        properties: { sessionID: created.id, info: { ...created, directory } },
      },
    })
    expect(sync.session.get(created.id)).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("events from a non-current workspace do not enter the current view", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const foreign = { ...session, id: "ses_foreign_workspace", directory }
  const current = { ...session, id: "ses_current_workspace", directory }
  const { app, emit, project, sync } = await mount(() => undefined, tmp.path)

  try {
    project.workspace.set("workspace_current")
    emit({
      directory,
      project: "proj_test",
      workspace: "workspace_other",
      payload: {
        id: "evt_foreign_workspace",
        type: "session.created",
        properties: { sessionID: foreign.id, info: foreign },
      },
    })
    emit({
      directory,
      project: "proj_test",
      workspace: "workspace_current",
      payload: {
        id: "evt_current_workspace",
        type: "session.created",
        properties: { sessionID: current.id, info: current },
      },
    })
    await wait(() => sync.session.get(current.id) !== undefined)

    expect(sync.session.get(foreign.id)).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("live status wins over a stale bootstrap status snapshot", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let requested = false
  let resolveStatus!: (response: Response) => void
  const status = new Promise<Response>((resolve) => {
    resolveStatus = resolve
  })
  const current = { ...session, directory }
  const { app, sync } = await mount(
    (url) => {
      if (url.pathname === "/session") return json([current])
      if (url.pathname === "/session/status") {
        requested = true
        return status
      }
      return undefined
    },
    tmp.path,
    async ({ emit }) => {
      await wait(() => requested)
      emit(
        global({
          id: "evt_status_live",
          type: "session.status",
          properties: { sessionID, status: { type: "busy" } },
        }),
      )
      resolveStatus(json({ [sessionID]: { type: "idle" } }))
    },
  )

  try {
    expect(sync.data.session_status[sessionID]).toEqual({ type: "busy" })
  } finally {
    app.renderer.destroy()
  }
})

test("live status before status bootstrap starts wins over its stale snapshot", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let providersRequested = false
  let resolveProviders!: (response: Response) => void
  const providers = new Promise<Response>((resolve) => {
    resolveProviders = resolve
  })
  const current = { ...session, directory }
  const { app, sync } = await mount(
    (url) => {
      if (url.pathname === "/session") return json([current])
      if (url.pathname === "/session/status") return json({ [sessionID]: { type: "idle" } })
      if (url.pathname === "/config/providers") {
        providersRequested = true
        return providers
      }
      if (url.pathname === `/session/${sessionID}`) return json(current)
      if (
        url.pathname === `/session/${sessionID}/message` ||
        url.pathname === `/session/${sessionID}/todo` ||
        url.pathname === `/session/${sessionID}/diff`
      )
        return json([])
      return undefined
    },
    tmp.path,
    async ({ emit }) => {
      await wait(() => providersRequested)
      emit(
        global({
          id: "evt_status_before_bootstrap",
          type: "session.status",
          properties: { sessionID, status: { type: "busy" } },
        }),
      )
      resolveProviders(json({ providers: [], default: {} }))
    },
  )

  try {
    expect(sync.data.session_status[sessionID]).toEqual({ type: "busy" })
  } finally {
    app.renderer.destroy()
  }
})
