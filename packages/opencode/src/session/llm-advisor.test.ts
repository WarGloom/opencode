import { describe, expect, test } from "bun:test"
import { applyAnthropicAdvisorToRequest } from "./llm"

describe("applyAnthropicAdvisorToRequest", () => {
  test("adds advisor tool and strips advisor option from provider options", () => {
    const result = applyAnthropicAdvisorToRequest({
      model: {
        id: "anthropic/claude-sonnet-4-6",
        api: { id: "claude-sonnet-4-6" },
      } as never,
      options: {
        anthropicAdvisor: {
          model: "anthropic/claude-opus-4-7",
          maxUses: 2,
        },
        foo: "bar",
      },
      tools: {},
    })

    expect(result.providerOptions).toEqual({ foo: "bar" })
    expect(result.advisor).toEqual({
      model: "anthropic/claude-opus-4-7",
      maxUses: 2,
    })
    expect(result.tools.advisor).toBeDefined()
    expect((result.tools.advisor as any).id).toBe("anthropic.advisor_20260301")
  })

  test("does not override an existing advisor tool", () => {
    const existing = { type: "provider", id: "existing" }
    const result = applyAnthropicAdvisorToRequest({
      model: {
        id: "anthropic/claude-sonnet-4-6",
        api: { id: "claude-sonnet-4-6" },
      } as never,
      options: { anthropicAdvisor: true },
      tools: { advisor: existing as never },
    })

    expect(result.tools.advisor === existing).toBe(true)
  })
})
