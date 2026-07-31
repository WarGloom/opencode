import { describe, expect, test } from "bun:test"
import { resolveRunThinking } from "@/cli/cmd/run"

describe("run thinking defaults", () => {
  test("hides thinking blocks unless explicitly requested", () => {
    expect(resolveRunThinking({ interactive: false })).toBe(false)
    expect(resolveRunThinking({ interactive: true })).toBe(false)
    expect(resolveRunThinking({ interactive: true, thinking: true })).toBe(true)
    expect(resolveRunThinking({ interactive: false, thinking: true })).toBe(true)
  })
})
