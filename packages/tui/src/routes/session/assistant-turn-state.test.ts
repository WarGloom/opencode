import { describe, expect, it } from "bun:test"
import {
  getAssistantTurnStateLabel,
  shouldRenderAssistantTurnSummary,
  type AssistantTurnStateInput,
} from "./assistant-turn-state"

function createInput(overrides: Partial<AssistantTurnStateInput> = {}): AssistantTurnStateInput {
  return {
    isLast: true,
    hasFinalFinish: false,
    hasRenderableParts: true,
    errorName: undefined,
    sessionStatus: "busy",
    ...overrides,
  }
}

describe("getAssistantTurnStateLabel", () => {
  it("marks an idle unfinished empty assistant turn as incomplete", () => {
    const result = getAssistantTurnStateLabel(createInput({
      hasRenderableParts: false,
      sessionStatus: "idle",
    }))

    expect(result).toBe("incomplete")
  })

  it("does not mark a busy unfinished assistant turn as incomplete", () => {
    const result = getAssistantTurnStateLabel(createInput({
      hasRenderableParts: false,
      sessionStatus: "busy",
    }))

    expect(result).toBeUndefined()
  })

  it("preserves interrupted label for aborted messages", () => {
    const result = getAssistantTurnStateLabel(createInput({
      errorName: "MessageAbortedError",
      sessionStatus: "idle",
    }))

    expect(result).toBe("interrupted")
  })

  it("does not label an interrupted unfinished empty assistant turn", () => {
    const result = getAssistantTurnStateLabel(createInput({
      hasRenderableParts: false,
      sessionStatus: "interrupted",
    }))

    expect(result).toBeUndefined()
  })

  it("renders an active empty assistant turn summary", () => {
    const result = shouldRenderAssistantTurnSummary(createInput({
      hasRenderableParts: false,
      sessionStatus: "busy",
    }))

    expect(result).toBe(true)
  })

  it("renders a final assistant turn summary", () => {
    const result = shouldRenderAssistantTurnSummary(createInput({
      isLast: false,
      hasFinalFinish: true,
    }))

    expect(result).toBe(true)
  })

  it("does not render a non-final non-last assistant summary just because it has parts", () => {
    const result = shouldRenderAssistantTurnSummary(createInput({
      isLast: false,
      hasFinalFinish: false,
      hasRenderableParts: true,
    }))

    expect(result).toBe(false)
  })

  it("renders an aborted assistant turn summary when it has visible parts", () => {
    const result = shouldRenderAssistantTurnSummary(createInput({
      isLast: false,
      hasRenderableParts: true,
      errorName: "MessageAbortedError",
    }))

    expect(result).toBe(true)
  })

  it("does not render an empty aborted assistant turn summary", () => {
    const result = shouldRenderAssistantTurnSummary(createInput({
      hasRenderableParts: false,
      errorName: "MessageAbortedError",
      sessionStatus: "idle",
    }))

    expect(result).toBe(false)
  })

  it("does not render an empty interrupted session summary", () => {
    const result = shouldRenderAssistantTurnSummary(createInput({
      hasRenderableParts: false,
      sessionStatus: "interrupted",
    }))

    expect(result).toBe(false)
  })
})
