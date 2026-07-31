import { describe, expect, test } from "bun:test"
import * as AnthropicAdvisor from "./anthropic-advisor"

describe("AnthropicAdvisor.extractAnthropicAdvisorConfig", () => {
  test("ignores falsy advisor settings", () => {
    expect(AnthropicAdvisor.extractAnthropicAdvisorConfig({ anthropicAdvisor: false }).advisor).toBeUndefined()
    expect(AnthropicAdvisor.extractAnthropicAdvisorConfig({ anthropicAdvisor: null }).advisor).toBeUndefined()
    expect(AnthropicAdvisor.extractAnthropicAdvisorConfig({ foo: "bar" }).advisor).toBeUndefined()
  })

  test("returns default advisor model when enabled with boolean true", () => {
    const result = AnthropicAdvisor.extractAnthropicAdvisorConfig({ anthropicAdvisor: true, foo: "bar" })

    expect(result.advisor).toEqual({ model: "claude-opus-5" })
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

  test("ignores object config when enabled is false", () => {
    const result = AnthropicAdvisor.extractAnthropicAdvisorConfig({
      anthropicAdvisor: { enabled: false, model: "claude-opus-4-7" },
      foo: "bar",
    })

    expect(result.advisor).toBeUndefined()
    expect(result.providerOptions).toEqual({ foo: "bar" })
  })

  test("rejects invalid maxUses", () => {
    expect(() =>
      AnthropicAdvisor.extractAnthropicAdvisorConfig({
        anthropicAdvisor: { maxUses: 0 },
      }),
    ).toThrow("anthropicAdvisor.maxUses must be a positive integer")
  })

  test("rejects invalid caching shape and ttl", () => {
    expect(() =>
      AnthropicAdvisor.extractAnthropicAdvisorConfig({
        anthropicAdvisor: { caching: true },
      }),
    ).toThrow("anthropicAdvisor.caching must be an object")

    expect(() =>
      AnthropicAdvisor.extractAnthropicAdvisorConfig({
        anthropicAdvisor: { caching: { ttl: "10m" } },
      }),
    ).toThrow("anthropicAdvisor.caching.ttl must be '5m' or '1h'")
  })
})

describe("AnthropicAdvisor.validateAnthropicAdvisorPair", () => {
  test("accepts haiku 4.5 and opus 4.7 executors", () => {
    expect(() =>
      AnthropicAdvisor.validateAnthropicAdvisorPair(
        {
          id: "anthropic/claude-haiku-4-5-20251001",
          api: { id: "claude-haiku-4-5-20251001" },
        } as never,
        { model: "claude-opus-4-7" },
      ),
    ).not.toThrow()

    expect(() =>
      AnthropicAdvisor.validateAnthropicAdvisorPair(
        {
          id: "anthropic/claude-opus-4-7",
          api: { id: "claude-opus-4-7" },
        } as never,
        { model: "claude-opus-4-7" },
      ),
    ).not.toThrow()
  })

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

  test("accepts opus 4.8 advisor model", () => {
    expect(() =>
      AnthropicAdvisor.validateAnthropicAdvisorPair(
        {
          id: "anthropic/claude-sonnet-4-6",
          api: { id: "claude-sonnet-4-6" },
        } as never,
        { model: "claude-opus-4-8" },
      ),
    ).not.toThrow()
  })

  test("accepts provider-prefixed opus 4.8 advisor model", () => {
    expect(() =>
      AnthropicAdvisor.validateAnthropicAdvisorPair(
        {
          id: "anthropic/claude-sonnet-4-6",
          api: { id: "claude-sonnet-4-6" },
        } as never,
        { model: "anthropic/claude-opus-4-8" },
      ),
    ).not.toThrow()
  })

  test("accepts opus 5 advisor model", () => {
    expect(() =>
      AnthropicAdvisor.validateAnthropicAdvisorPair(
        {
          id: "anthropic/claude-sonnet-4-6",
          api: { id: "claude-sonnet-4-6" },
        } as never,
        { model: "claude-opus-5" },
      ),
    ).not.toThrow()
  })

  test("accepts provider-prefixed opus 5 advisor model", () => {
    expect(() =>
      AnthropicAdvisor.validateAnthropicAdvisorPair(
        {
          id: "anthropic/claude-sonnet-4-6",
          api: { id: "claude-sonnet-4-6" },
        } as never,
        { model: "anthropic/claude-opus-5" },
      ),
    ).not.toThrow()
  })

  test("accepts opus 4.8 executor with opus 4.8 advisor", () => {
    expect(() =>
      AnthropicAdvisor.validateAnthropicAdvisorPair(
        {
          id: "anthropic/claude-opus-4-8",
          api: { id: "claude-opus-4-8" },
        } as never,
        { model: "claude-opus-4-8" },
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

describe("AnthropicAdvisor.createAnthropicAdvisorTool", () => {
  test("strips provider prefix from advisor model id", () => {
    const tool = AnthropicAdvisor.createAnthropicAdvisorTool({
      model: "anthropic/claude-opus-4-7",
      maxUses: 1,
    }) as any

    expect(tool.id).toBe("anthropic.advisor_20260301")
    expect(tool.args.model).toBe("claude-opus-4-7")
    expect(tool.args.maxUses).toBe(1)
  })
})
