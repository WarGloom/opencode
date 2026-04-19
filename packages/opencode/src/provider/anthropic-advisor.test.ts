import { describe, expect, test } from "bun:test"
import { AnthropicAdvisor } from "./index"

describe("AnthropicAdvisor.extractAnthropicAdvisorConfig", () => {
  test("returns default advisor model when enabled with boolean true", () => {
    const result = AnthropicAdvisor.extractAnthropicAdvisorConfig({ anthropicAdvisor: true, foo: "bar" })

    expect(result.advisor).toEqual({ model: "claude-opus-4-7" })
    expect(result.providerOptions).toEqual({ foo: "bar" })
  })

  test("normalizes maxUses and caching options", () => {
    const result = AnthropicAdvisor.extractAnthropicAdvisorConfig({
      anthropicAdvisor: {
        model: "anthropic/claude-opus-4-7",
        maxUses: 3,
        caching: { ttl: "5m" },
      },
    })

    expect(result.advisor).toEqual({
      model: "anthropic/claude-opus-4-7",
      maxUses: 3,
      caching: { type: "ephemeral", ttl: "5m" },
    })
  })
})

describe("AnthropicAdvisor.validateAnthropicAdvisorPair", () => {
  test("accepts sonnet 4.6 executor with opus 4.7 advisor", () => {
    expect(() =>
      AnthropicAdvisor.validateAnthropicAdvisorPair(
        {
          id: "anthropic/claude-sonnet-4-6",
          api: { id: "claude-sonnet-4-6" },
        } as never,
        { model: "claude-opus-4-7" },
      ),
    ).not.toThrow()
  })

  test("rejects unsupported advisor model", () => {
    expect(() =>
      AnthropicAdvisor.validateAnthropicAdvisorPair(
        {
          id: "anthropic/claude-sonnet-4-6",
          api: { id: "claude-sonnet-4-6" },
        } as never,
        { model: "claude-opus-4-6" },
      ),
    ).toThrow("Unsupported anthropic advisor model")
  })

  test("rejects unsupported executor model", () => {
    expect(() =>
      AnthropicAdvisor.validateAnthropicAdvisorPair(
        {
          id: "anthropic/claude-sonnet-4-5",
          api: { id: "claude-sonnet-4-5" },
        } as never,
        { model: "claude-opus-4-7" },
      ),
    ).toThrow("Unsupported anthropic advisor executor model")
  })
})
