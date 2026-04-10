import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Prompt,
  SharedV3Warning,
} from "@ai-sdk/provider"

interface SerializedPrompt {
  prompt: string
  systemPrompt: string
  warnings: SharedV3Warning[]
}

export function serializeClaudeCodePrompt(
  prompt: LanguageModelV3Prompt,
  options: Pick<LanguageModelV3CallOptions, "responseFormat" | "seed" | "stopSequences" | "temperature" | "topK" | "topP" | "frequencyPenalty" | "presencePenalty" | "maxOutputTokens" | "toolChoice" | "tools">,
): SerializedPrompt {
  const warnings: SharedV3Warning[] = []
  const transcript: string[] = []
  const systemPrompts: string[] = [
    "You are running inside OpenCode through the Claude Code compatibility provider.",
    "Use the transcript provided in this prompt as your conversation context.",
    "If Claude Code native tools are available and useful, you may use them.",
    "OpenCode tool definitions are not bridged into Claude Code as executable tools in this provider.",
  ]

  for (const message of prompt) {
    if (message.role === "system") {
      if (message.content.trim()) systemPrompts.push(message.content.trim())
      continue
    }

    transcript.push(labelForRole(message.role))

    for (const part of message.content) {
      switch (part.type) {
        case "text":
          transcript.push(part.text)
          break
        case "reasoning":
          transcript.push(`[Reasoning]\n${part.text}`)
          break
        case "file":
          warnings.push({
            type: "unsupported",
            feature: "prompt.file",
            details: "Claude Code compatibility provider currently accepts text-only prompt content.",
          })
          transcript.push(
            `[Unsupported file omitted${part.filename ? `: ${part.filename}` : ""}${part.mediaType ? ` (${part.mediaType})` : ""}]`,
          )
          break
        case "tool-call":
          transcript.push(`[Tool call ${part.toolName} id=${part.toolCallId}]\n${safeJson(part.input)}`)
          break
        case "tool-result":
          transcript.push(`[Tool result ${part.toolName} id=${part.toolCallId}]\n${renderToolResult(part.output)}`)
          break
        case "tool-approval-response":
          transcript.push(
            `[Tool approval ${part.approved ? "approved" : "denied"} id=${part.approvalId}${part.reason ? `: ${part.reason}` : ""}]`,
          )
          break
      }
    }

    transcript.push("")
  }

  if (options.tools?.length) {
    warnings.push({
      type: "compatibility",
      feature: "tools",
      details: "Claude Code compatibility provider serializes OpenCode tool history as transcript context, but only Claude native tools can run in this path.",
    })
  }

  if (options.toolChoice && options.toolChoice.type !== "none" && options.tools?.length) {
    warnings.push({
      type: "unsupported",
      feature: "toolChoice",
      details: "Claude Code compatibility provider does not support OpenCode tool selection yet.",
    })
  }

  if (options.responseFormat?.type === "json") {
    warnings.push({
      type: "compatibility",
      feature: "responseFormat",
      details: "Claude Code compatibility provider does not enforce JSON schema output yet.",
    })
  }

  for (const [feature, value] of [
    ["seed", options.seed],
    ["stopSequences", options.stopSequences?.length ? options.stopSequences : undefined],
    ["temperature", options.temperature],
    ["topK", options.topK],
    ["topP", options.topP],
    ["frequencyPenalty", options.frequencyPenalty],
    ["presencePenalty", options.presencePenalty],
    ["maxOutputTokens", options.maxOutputTokens],
  ] as const) {
    if (value === undefined) continue
    warnings.push({
      type: "unsupported",
      feature,
    })
  }

  const serialized = transcript.join("\n").trim()
  if (!serialized) {
    transcript.push("User:\nPlease continue.")
  }

  return {
    prompt: transcript.join("\n").trim(),
    systemPrompt: systemPrompts.join("\n\n").trim(),
    warnings,
  }
}

function labelForRole(role: "user" | "assistant" | "tool") {
  switch (role) {
    case "assistant":
      return "Assistant:"
    case "tool":
      return "Tool:"
    default:
      return "User:"
  }
}

function renderToolResult(
  output:
    | { type: "text"; value: string }
    | { type: "json"; value: unknown }
    | { type: "execution-denied"; reason?: string }
    | { type: "error-text"; value: string }
    | { type: "error-json"; value: unknown }
    | { type: "content"; value: Array<{ type: string; [key: string]: unknown }> },
) {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value
    case "json":
    case "error-json":
      return safeJson(output.value)
    case "execution-denied":
      return output.reason ?? "execution denied"
    case "content":
      return output.value
        .map((item) => {
          if (item.type === "text" && typeof item.text === "string") return item.text
          return `[${item.type}]`
        })
        .join("\n")
    default:
      return "[Unsupported tool result]"
  }
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
