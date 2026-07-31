export type AssistantTurnStateInput = {
  isLast: boolean
  hasFinalFinish: boolean
  hasRenderableParts: boolean
  errorName?: string
  sessionStatus?: string
}

export function getAssistantTurnStateLabel(input: AssistantTurnStateInput) {
  if (input.errorName === "MessageAbortedError") return input.hasRenderableParts ? "interrupted" : undefined
  if (!input.isLast) return
  if (input.hasFinalFinish) return
  if (input.hasRenderableParts) return
  if (input.sessionStatus === "interrupted") return
  if (input.sessionStatus === "idle") return "incomplete"
}

export function shouldRenderAssistantTurnSummary(input: AssistantTurnStateInput) {
  if (
    !input.hasRenderableParts &&
    !input.hasFinalFinish &&
    (input.errorName === "MessageAbortedError" || input.sessionStatus === "interrupted")
  ) {
    return false
  }
  return input.isLast || input.hasFinalFinish || getAssistantTurnStateLabel(input) !== undefined
}
