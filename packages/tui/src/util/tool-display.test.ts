import { describe, expect, test } from "bun:test"

import { formatToolInputSummary } from "./tool-display"

describe("formatToolInputSummary", () => {
  test("omits empty optional strings and shows nested inputs", () => {
    expect(formatToolInputSummary({
      teamName: "",
      inline_spec: { name: "project-analysis-team", members: [] },
      leadSessionId: "",
    })).toBe("[inline_spec={...}]")
  })

  test("formats primitive and array values", () => {
    expect(formatToolInputSummary({
      teamRunId: "112f8d3a-6132-41fb-944d-5dc8ca5a0e18",
      to: "lead",
      retry: false,
      references: [{ path: "README.md" }],
      unused: undefined,
    })).toBe("[teamRunId=112f8d3a-6132-41fb-944d-5dc8ca5a0e18, to=lead, retry=false, references=[...]]")
  })
})
