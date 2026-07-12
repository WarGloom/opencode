/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { assistant, global, json, messageID, mount, partID, session, sessionID, wait } from "./sync-fixture"
test("a message removed during hydration does not regain stale parts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    emit(
      global({
        id: "evt_message",
        type: "message.updated",
        properties: { sessionID, info: assistant },
      }),
    )
    await wait(() => sync.data.message[sessionID]?.length === 1)
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(
      global({
        id: "evt_removed",
        type: "message.removed",
        properties: { sessionID, messageID },
      }),
    )
    await wait(() => sync.data.message[sessionID]?.length === 0)
    resolveMessages(
      json([
        {
          info: assistant,
          parts: [{ id: partID, sessionID, messageID, type: "text", text: "stale" }],
        },
      ]),
    )
    await hydrate

    expect(sync.data.message[sessionID]).toEqual([])
    expect(sync.data.part[messageID]).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("a part removed during hydration does not reappear", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let requested = false
  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  const stalePart = { id: partID, sessionID, messageID, type: "text" as const, text: "stale" }
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    sync.set("message", sessionID, [assistant])
    sync.set("part", messageID, [stalePart])
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(
      global({
        id: "evt_part_removed_during_hydration",
        type: "message.part.removed",
        properties: { sessionID, messageID, partID },
      }),
    )
    await wait(() => sync.data.part[messageID] === undefined)
    resolveMessages(json([{ info: assistant, parts: [stalePart] }]))
    await hydrate

    expect(sync.data.part[messageID]).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("message and part removals before hydration beat stale responses", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const removedMessage = { ...assistant, id: "msg_removed_before_hydration" }
  const retainedMessage = { ...assistant, id: "msg_retained_before_hydration" }
  const removedMessagePart = {
    id: "prt_removed_message",
    sessionID,
    messageID: removedMessage.id,
    type: "text" as const,
    text: "stale",
  }
  const removedPart = {
    id: "prt_removed_before_hydration",
    sessionID,
    messageID: retainedMessage.id,
    type: "text" as const,
    text: "stale",
  }
  const retainedPart = { ...removedPart, id: "prt_retained_before_hydration", text: "retained" }
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`)
      return json([
        { info: removedMessage, parts: [removedMessagePart] },
        { info: retainedMessage, parts: [removedPart, retainedPart] },
      ])
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    emit(
      global({
        id: "evt_removed_message_seed",
        type: "message.updated",
        properties: { sessionID, info: removedMessage },
      }),
    )
    emit(
      global({
        id: "evt_retained_message_seed",
        type: "message.updated",
        properties: { sessionID, info: retainedMessage },
      }),
    )
    emit(
      global({
        id: "evt_removed_part_seed",
        type: "message.part.updated",
        properties: { sessionID, time: 1, part: removedPart },
      }),
    )
    emit(
      global({
        id: "evt_retained_part_seed",
        type: "message.part.updated",
        properties: { sessionID, time: 1, part: retainedPart },
      }),
    )
    emit(
      global({
        id: "evt_message_removed_before_hydration",
        type: "message.removed",
        properties: { sessionID, messageID: removedMessage.id },
      }),
    )
    emit(
      global({
        id: "evt_part_removed_before_hydration",
        type: "message.part.removed",
        properties: { sessionID, messageID: retainedMessage.id, partID: removedPart.id },
      }),
    )

    await wait(
      () =>
        sync.data.message[sessionID]?.every((message) => message.id !== removedMessage.id) === true &&
        sync.data.part[retainedMessage.id]?.every((part) => part.id !== removedPart.id) === true,
    )

    await sync.session.sync(sessionID)

    expect(sync.data.message[sessionID]?.map((message) => message.id)).toEqual([retainedMessage.id])
    expect(sync.data.part[removedMessage.id]).toBeUndefined()
    expect(sync.data.part[retainedMessage.id]).toEqual([retainedPart])
  } finally {
    app.renderer.destroy()
  }
})

test("message and part removals immediately clear activity state", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const secondPartID = "prt_second"
  const { app, emit, sync } = await mount(() => undefined, tmp.path)

  try {
    sync.set("message", sessionID, [assistant])
    sync.set("part", messageID, [
      { id: partID, sessionID, messageID, type: "text", text: "one" },
      { id: secondPartID, sessionID, messageID, type: "text", text: "two" },
    ])
    emit(
      global({
        id: "evt_part_removed",
        type: "message.part.removed",
        properties: { sessionID, messageID, partID },
      }),
    )
    expect(sync.data.part[messageID].map((part) => part.id)).toEqual([secondPartID])

    emit(
      global({
        id: "evt_message_removed",
        type: "message.removed",
        properties: { sessionID, messageID },
      }),
    )
    await wait(() => sync.data.message[sessionID]?.length === 0 && sync.data.part[messageID] === undefined)
    expect(sync.data.message[sessionID]).toEqual([])
    expect(sync.data.part[messageID]).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})
