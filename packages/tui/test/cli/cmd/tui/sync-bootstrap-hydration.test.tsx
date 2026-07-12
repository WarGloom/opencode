/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { assistant, json, messageID, mount, session, sessionID } from "./sync-fixture"
test("bootstrap hydrates messages and parts for sessions that are already busy", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const user = {
    id: "msg_busy_user",
    sessionID,
    role: "user" as const,
    time: { created: 0 },
    agent: "explore",
    model: { providerID: "test", modelID: "model" },
  }
  const running = {
    id: "prt_busy_bash",
    sessionID,
    messageID,
    type: "tool" as const,
    callID: "call_busy_bash",
    tool: "bash",
    state: {
      status: "running" as const,
      input: { command: "sleep 60" },
      time: { start: 1 },
    },
  }
  const busyAssistant = { ...assistant, time: { created: 1 } }
  const { app, sync } = await mount((url) => {
    if (url.pathname === "/session/status") return json({ [sessionID]: { type: "busy" } })
    if (url.pathname === "/session") return json([session])
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`)
      return json([
        { info: user, parts: [] },
        { info: busyAssistant, parts: [running] },
      ])
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    expect(sync.data.message[sessionID].find((message) => message.role === "user")?.agent).toBe("explore")
    expect(sync.data.part[messageID]).toEqual([running])
  } finally {
    app.renderer.destroy()
  }
})

test("bootstrap hydrates only busy sessions returned by the filtered session list", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const listedID = "ses_listed_busy"
  const unlistedID = "ses_unlisted_busy"
  const listed = { ...session, id: listedID }
  let listedRequests = 0
  let unlistedRequests = 0
  const { app, sync } = await mount((url) => {
    if (url.pathname === "/session/status")
      return json({
        [listedID]: { type: "busy" },
        [unlistedID]: { type: "busy" },
      })
    if (url.pathname === "/session") return json([listed])
    if (url.pathname.startsWith(`/session/${unlistedID}`)) {
      unlistedRequests += 1
      if (url.pathname === `/session/${unlistedID}`) return json({ ...session, id: unlistedID })
      return json([])
    }
    if (url.pathname === `/session/${listedID}`) {
      listedRequests += 1
      return json({ message: "session ended" }, { status: 404 })
    }
    if (
      url.pathname === `/session/${listedID}/message` ||
      url.pathname === `/session/${listedID}/todo` ||
      url.pathname === `/session/${listedID}/diff`
    ) {
      listedRequests += 1
      return json([])
    }
    return undefined
  }, tmp.path)

  try {
    expect(sync.status).toBe("complete")
    expect(listedRequests).toBeGreaterThan(0)
    expect(unlistedRequests).toBe(0)
    expect(sync.session.get(listedID)).toBeUndefined()
    expect(sync.data.session_status[listedID]).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})
