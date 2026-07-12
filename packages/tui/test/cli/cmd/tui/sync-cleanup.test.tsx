/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { assistant, directory, global, messageID, mount, partID, session, sessionID, wait } from "./sync-fixture"
test("orphan removal events are safe and do not create state", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(() => undefined, tmp.path)

  try {
    emit(
      global({
        id: "evt_orphan_message_removed",
        type: "message.removed",
        properties: { sessionID, messageID },
      }),
    )
    emit(
      global({
        id: "evt_orphan_part_removed",
        type: "message.part.removed",
        properties: { sessionID, messageID, partID },
      }),
    )

    expect(sync.data.message[sessionID]).toBeUndefined()
    expect(sync.data.part[messageID]).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("session deletion clears all session activity state", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const orphanMessageID = "msg_orphan_part"
  const { app, emit, sync } = await mount(() => undefined, tmp.path)

  try {
    sync.set("session", [{ ...session, directory }])
    sync.set("session_status", sessionID, { type: "busy" })
    sync.set("todo", sessionID, [{ content: "work", status: "pending", priority: "medium" }])
    sync.set("session_diff", sessionID, [{ file: "file.ts", additions: 1, deletions: 0 }])
    sync.set("message", sessionID, [assistant])
    sync.set("part", messageID, [{ id: partID, sessionID, messageID, type: "text", text: "active" }])
    sync.set("part", orphanMessageID, [
      { id: "prt_orphan", sessionID, messageID: orphanMessageID, type: "text", text: "active" },
    ])
    emit(
      global({
        id: "evt_session_cleanup",
        type: "session.deleted",
        properties: { sessionID, info: { ...session, directory } },
      }),
    )
    await wait(() => sync.session.get(sessionID) === undefined)

    expect(sync.data.session_status[sessionID]).toBeUndefined()
    expect(sync.data.todo[sessionID]).toBeUndefined()
    expect(sync.data.session_diff[sessionID]).toBeUndefined()
    expect(sync.data.message[sessionID]).toBeUndefined()
    expect(sync.data.part[messageID]).toBeUndefined()
    expect(sync.data.part[orphanMessageID]).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})
