/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { directory, global, json, mount, session, wait } from "./sync-fixture"
test("live session creation adds the session to sync state", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const created = {
    ...session,
    id: "ses_live_created",
    slug: "live-created",
    projectID: "proj_test",
    parentID: "ses_parent",
  }
  const { app, emit, sync } = await mount(() => undefined, tmp.path)

  try {
    // when
    emit(
      global({
        id: "evt_session_created",
        type: "session.created",
        properties: { sessionID: created.id, info: created },
      }),
    )

    // then
    expect(sync.data.session).toContainEqual(created)
  } finally {
    app.renderer.destroy()
  }
})

test("live session creation survives an older bootstrap list snapshot", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const created = {
    ...session,
    id: "ses_created_during_list",
    slug: "created-during-list",
    projectID: "proj_test",
    parentID: "ses_parent",
  }
  let requested = false
  let resolveList!: (response: Response) => void
  const list = new Promise<Response>((resolve) => {
    resolveList = resolve
  })
  const { app, sync } = await mount(
    (url) => {
      if (url.pathname !== "/session") return undefined
      requested = true
      return list
    },
    tmp.path,
    async ({ emit }) => {
      await wait(() => requested)
      emit(
        global({
          id: "evt_session_created_during_list",
          type: "session.created",
          properties: { sessionID: created.id, info: created },
        }),
      )
      resolveList(json([]))
    },
  )

  try {
    expect(sync.data.session).toContainEqual(created)
  } finally {
    app.renderer.destroy()
  }
})

test("live session creation after the list resolves survives delayed bootstrap application", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const created = { ...session, id: "ses_created_after_list", directory }
  let listed = false
  let resolveProviders!: (response: Response) => void
  const providers = new Promise<Response>((resolve) => {
    resolveProviders = resolve
  })
  const { app, sync } = await mount(
    (url) => {
      if (url.pathname === "/session") {
        listed = true
        return json([])
      }
      if (url.pathname === "/config/providers") return providers
      return undefined
    },
    tmp.path,
    async ({ emit }) => {
      await wait(() => listed)
      emit(
        global({
          id: "evt_session_created_after_list",
          type: "session.created",
          properties: { sessionID: created.id, info: created },
        }),
      )
      resolveProviders(json({ providers: {}, default: {} }))
    },
    { continue: true },
  )

  try {
    expect(sync.data.session).toContainEqual(created)
  } finally {
    app.renderer.destroy()
  }
})

test("live session creation survives stale refreshes until the list acknowledges it", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const created = { ...session, id: "ses_created_before_refresh", directory }
  let lists = 0
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname !== "/session") return undefined
    lists += 1
    if (lists === 3) return json([created])
    return json([])
  }, tmp.path)

  try {
    emit(
      global({
        id: "evt_created_before_refresh",
        type: "session.created",
        properties: { sessionID: created.id, info: created },
      }),
    )

    await sync.session.refresh()
    expect(sync.session.get(created.id)).toEqual(created)

    await sync.session.refresh()
    expect(sync.session.get(created.id)).toEqual(created)

    await sync.session.refresh()
    expect(sync.session.get(created.id)).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("session tombstones survive stale refreshes and are pruned after acknowledgement", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const deleted = { ...session, id: "ses_deleted_before_refresh", directory }
  let lists = 0
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname !== "/session") return undefined
    lists += 1
    if (lists === 4) return json([])
    return json([deleted])
  }, tmp.path)

  try {
    emit(
      global({
        id: "evt_deleted_before_refresh",
        type: "session.deleted",
        properties: { sessionID: deleted.id, info: deleted },
      }),
    )

    await sync.session.refresh()
    expect(sync.session.get(deleted.id)).toBeUndefined()

    await sync.session.refresh()
    expect(sync.session.get(deleted.id)).toBeUndefined()

    await sync.session.refresh()
    expect(sync.session.get(deleted.id)).toBeUndefined()

    await sync.session.refresh()
    expect(sync.session.get(deleted.id)).toEqual(deleted)
  } finally {
    app.renderer.destroy()
  }
})

test("live session deletion is not resurrected by an older bootstrap list snapshot", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const deleted = { ...session, id: "ses_deleted_during_list" }
  let requested = false
  let resolveList!: (response: Response) => void
  const list = new Promise<Response>((resolve) => {
    resolveList = resolve
  })
  const { app, sync } = await mount(
    (url) => {
      if (url.pathname !== "/session") return undefined
      requested = true
      return list
    },
    tmp.path,
    async ({ emit }) => {
      await wait(() => requested)
      emit(
        global({
          id: "evt_session_deleted_during_list",
          type: "session.deleted",
          properties: { sessionID: deleted.id, info: deleted },
        }),
      )
      resolveList(json([deleted]))
    },
  )

  try {
    expect(sync.data.session).not.toContainEqual(deleted)
  } finally {
    app.renderer.destroy()
  }
})
