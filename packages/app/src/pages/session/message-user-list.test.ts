import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2"
import { visibleUserMessages } from "./message-user-list"

describe("session message user list", () => {
  test("dedupes repeated user messages before timeline rendering", () => {
    const user = {
      id: "msg-user-1",
      role: "user",
      sessionID: "ses-1",
      time: { created: 1 },
    } as Message
    const duplicate = {
      ...user,
      time: { created: 2 },
    } as Message
    const assistant = {
      id: "msg-assistant-1",
      role: "assistant",
      sessionID: "ses-1",
      parentID: "msg-user-1",
      time: { created: 3 },
    } as Message

    expect(visibleUserMessages([user, duplicate, assistant]).map((message) => message.id)).toEqual(["msg-user-1"])
  })
})
