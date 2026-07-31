import { describe, expect, test } from "bun:test"
import { displayName, parse } from "../../src/util/model"

describe("util.model", () => {
  test("splits provider from a nested model identifier", () => {
    expect(parse("provider/org/model")).toEqual({ providerID: "provider", modelID: "org/model" })
    expect(parse("invalid")).toEqual({ providerID: "invalid", modelID: "" })
  })

  test("renders variants adjacent to the model name", () => {
    expect(displayName("Claude Sonnet 4", " high ")).toBe("Claude Sonnet 4 (high)")
    expect(displayName("Claude Sonnet 4", "extra   high")).toBe("Claude Sonnet 4 (extra high)")
  })

  test("keeps model names unchanged without a variant", () => {
    expect(displayName("Claude Sonnet 4")).toBe("Claude Sonnet 4")
    expect(displayName("Claude Sonnet 4", "   ")).toBe("Claude Sonnet 4")
  })
})
