import {
  APICallError,
  type JSONObject,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3FinishReason,
  type LanguageModelV3GenerateResult,
  type LanguageModelV3ResponseMetadata,
  type LanguageModelV3StreamPart,
  type LanguageModelV3Usage,
  type SharedV3Warning,
} from "@ai-sdk/provider"

import { errorMessage } from "@/util/error"
import type { ClaudeCodeExecution, ClaudeCodeStartInput } from "./transport"
import { startClaudeCodeCommand } from "./transport"
import { serializeClaudeCodePrompt } from "./serialize-prompt"

interface ClaudeCodeLanguageModelConfig {
  addDir?: string[]
  bare?: boolean
  binaryPath: string
  cwd: string
  disableSlashCommands?: boolean
  maxTurns?: number
  mcpConfig?: string[]
  permissionMode?: import("./provider").ClaudeCodePermissionMode
  pluginDir?: string[]
  provider: string
  settingSources?: import("./provider").ClaudeCodeSettingSource[]
  start?: (input: ClaudeCodeStartInput) => ClaudeCodeExecution
  strictMcpConfig?: boolean
  tools?: string[]
}

export class ClaudeCodeLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3"
  readonly supportedUrls = {}

  constructor(
    readonly modelId: string,
    private readonly config: ClaudeCodeLanguageModelConfig,
  ) {}

  get provider() {
    return this.config.provider
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const streamResult = await this.doStream(options)
    const reader = streamResult.stream.getReader()
    const content: LanguageModelV3Content[] = []
    const warnings: SharedV3Warning[] = []
    let text = ""
    let reasoning = ""
    let finishReason: LanguageModelV3FinishReason = { unified: "other", raw: undefined }
    let usage = emptyUsage()
    let response: LanguageModelV3ResponseMetadata | undefined

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      switch (value.type) {
        case "stream-start":
          warnings.push(...value.warnings)
          break
        case "response-metadata":
          response = value
          break
        case "text-delta":
          text += value.delta
          break
        case "reasoning-delta":
          reasoning += value.delta
          break
        case "tool-call":
          content.push({
            type: "tool-call",
            toolCallId: value.toolCallId,
            toolName: value.toolName,
            input: value.input,
            providerExecuted: value.providerExecuted,
          })
          break
        case "tool-result":
          content.push({
            type: "tool-result",
            toolCallId: value.toolCallId,
            toolName: value.toolName,
            result: value.result,
          })
          break
        case "finish":
          finishReason = value.finishReason
          usage = value.usage
          break
        case "error":
          throw toCliError({
            error: value.error,
            modelId: this.modelId,
            provider: this.provider,
            requestBodyValues: streamResult.request?.body,
          })
      }
    }

    if (reasoning) content.push({ type: "reasoning", text: reasoning })
    if (text) content.push({ type: "text", text })

    return {
      content,
      finishReason,
      usage,
      warnings,
      request: streamResult.request,
      response,
    }
  }

  async doStream(options: LanguageModelV3CallOptions) {
    const serialized = serializeClaudeCodePrompt(options.prompt, options)
    const execution = this.start({
      abortSignal: options.abortSignal,
      addDir: this.config.addDir,
      bare: this.config.bare,
      binaryPath: this.config.binaryPath,
      cwd: this.config.cwd,
      disableSlashCommands: this.config.disableSlashCommands,
      maxTurns: this.config.maxTurns,
      mcpConfig: this.config.mcpConfig,
      modelId: this.modelId,
      permissionMode: this.config.permissionMode,
      pluginDir: this.config.pluginDir,
      prompt: serialized.prompt,
      settingSources: this.config.settingSources,
      strictMcpConfig: this.config.strictMcpConfig,
      systemPrompt: serialized.systemPrompt,
      tools: this.config.tools,
    })

    const request = {
      body: {
        command: execution.command,
        prompt: serialized.prompt,
        systemPrompt: serialized.systemPrompt,
      },
    }

    return {
      request,
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start: async (controller) => {
          const usage = emptyUsage()
          const responseMetadata: LanguageModelV3ResponseMetadata = {
            modelId: this.modelId,
          }
          let responseMetadataSent = false
          let textStarted = false
          let reasoningStarted = false
          let textSoFar = ""
          let reasoningSoFar = ""
          const toolNames = new Map<string, string>()
          const toolCalls = new Set<string>()
          const toolResults = new Set<string>()
          let finishReason: LanguageModelV3FinishReason = { unified: "other", raw: undefined }
          let streamErrored = false

          controller.enqueue({ type: "stream-start", warnings: serialized.warnings })

          try {
            for await (const line of execution.lines) {
              const trimmed = line.trim()
              if (!trimmed) continue

              const raw = parseClaudeCodeLine(trimmed)
              if (options.includeRawChunks) controller.enqueue({ type: "raw", rawValue: raw })

              if (!responseMetadataSent && (raw.type === "assistant" || raw.type === "result")) {
                responseMetadataSent = true
                const messageId = extractString(raw, ["message", "id"]) ?? extractString(raw, ["id"])
                const sessionId = extractString(raw, ["session_id"])
                controller.enqueue({
                  type: "response-metadata",
                  ...responseMetadata,
                  ...(messageId ? { id: messageId } : {}),
                  ...(sessionId ? { id: sessionId } : {}),
                })
              }

              if (raw.type === "assistant") {
                for (const toolUse of extractToolUses(raw)) {
                  if (toolCalls.has(toolUse.id)) continue
                  toolCalls.add(toolUse.id)
                  toolNames.set(toolUse.id, toolUse.name)
                  controller.enqueue({ type: "tool-input-start", id: toolUse.id, toolName: toolUse.name })
                  controller.enqueue({ type: "tool-input-delta", id: toolUse.id, delta: toolUse.input })
                  controller.enqueue({ type: "tool-input-end", id: toolUse.id })
                  controller.enqueue({
                    type: "tool-call",
                    toolCallId: toolUse.id,
                    toolName: toolUse.name,
                    input: toolUse.input,
                    providerExecuted: true,
                  })
                }

                const nextReasoning = extractAssistantText(raw, "reasoning")
                if (nextReasoning !== undefined) {
                  const delta = diffSuffix(reasoningSoFar, nextReasoning)
                  if (delta) {
                    if (!reasoningStarted) {
                      controller.enqueue({ type: "reasoning-start", id: "reasoning-0" })
                      reasoningStarted = true
                    }
                    controller.enqueue({ type: "reasoning-delta", id: "reasoning-0", delta })
                    reasoningSoFar = nextReasoning
                  }
                }

                const nextText = extractAssistantText(raw, "text")
                if (nextText !== undefined) {
                  const delta = diffSuffix(textSoFar, nextText)
                  if (delta) {
                    if (!textStarted) {
                      controller.enqueue({ type: "text-start", id: "txt-0" })
                      textStarted = true
                    }
                    controller.enqueue({ type: "text-delta", id: "txt-0", delta })
                    textSoFar = nextText
                  }
                }
                continue
              }

              if (raw.type === "user") {
                for (const toolResult of extractToolResults(raw, toolNames)) {
                  if (toolResults.has(toolResult.toolCallId)) continue
                  toolResults.add(toolResult.toolCallId)
                  controller.enqueue({
                    type: "tool-result",
                    toolCallId: toolResult.toolCallId,
                    toolName: toolResult.toolName,
                    result: toolResult.result,
                  })
                }
                continue
              }

              if (raw.type !== "result") continue

              if (reasoningStarted) controller.enqueue({ type: "reasoning-end", id: "reasoning-0" })
              if (textStarted) controller.enqueue({ type: "text-end", id: "txt-0" })

              usage.raw = toJsonObject(raw)
              finishReason = {
                unified: raw.subtype === "error" || raw.is_error === true ? "error" : "stop",
                raw: typeof raw.subtype === "string" ? raw.subtype : undefined,
              }

              if (raw.is_error === true || raw.subtype === "error") {
                streamErrored = true
                controller.enqueue({
                  type: "error",
                  error: toCliError({
                    error: raw.error ?? raw.result ?? raw.message ?? "Claude CLI reported an error",
                    modelId: this.modelId,
                    provider: this.provider,
                    requestBodyValues: request.body,
                  }),
                })
                controller.close()
                return
              }

              controller.enqueue({
                type: "finish",
                finishReason,
                usage,
              })
              controller.close()
              return
            }

            const [exitCode, stderr] = await Promise.all([execution.exit, execution.stderr])
            if (exitCode !== 0) {
              streamErrored = true
              controller.enqueue({
                type: "error",
                error: toCliError({
                  error: stderr || `Claude CLI exited with code ${exitCode}`,
                  modelId: this.modelId,
                  provider: this.provider,
                  requestBodyValues: request.body,
                }),
              })
              controller.close()
              return
            }

            if (!responseMetadataSent) {
              controller.enqueue({ type: "response-metadata", ...responseMetadata })
            }
            if (reasoningStarted) controller.enqueue({ type: "reasoning-end", id: "reasoning-0" })
            if (textStarted) controller.enqueue({ type: "text-end", id: "txt-0" })
            if (!streamErrored) {
              controller.enqueue({
                type: "finish",
                finishReason: textStarted || reasoningStarted ? { unified: "stop", raw: undefined } : finishReason,
                usage,
              })
            }
            controller.close()
          } catch (error) {
            controller.enqueue({
              type: "error",
              error: toCliError({
                error,
                modelId: this.modelId,
                provider: this.provider,
                requestBodyValues: request.body,
              }),
            })
            controller.close()
          }
        },
      }),
    }
  }

  private start(input: ClaudeCodeStartInput) {
    return (this.config.start ?? startClaudeCodeCommand)(input)
  }
}

function diffSuffix(previous: string, next: string) {
  if (!previous) return next
  if (next.startsWith(previous)) return next.slice(previous.length)
  return next
}

function extractAssistantText(raw: Record<string, unknown>, kind: "text" | "reasoning") {
  const message = raw.message
  if (!message || typeof message !== "object") return undefined
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined

  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return []
      if (kind === "text" && part.type === "text" && typeof part.text === "string") return [part.text]
      if (kind === "reasoning" && part.type === "reasoning" && typeof part.text === "string") return [part.text]
      if (kind === "reasoning" && part.type === "thinking" && typeof part.thinking === "string") return [part.thinking]
      return []
    })
    .join("")
}

function extractToolUses(raw: Record<string, unknown>) {
  const message = raw.message
  if (!message || typeof message !== "object") return []
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return []

  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return []
    if (part.type !== "tool_use") return []
    const id = typeof part.id === "string" ? part.id : undefined
    const toolName = typeof part.name === "string" ? part.name : undefined
    if (!id || !toolName) return []
    const input = JSON.stringify((part as { input?: unknown }).input ?? {})
    return [{ id, input, name: toolName }]
  })
}

function extractToolResults(raw: Record<string, unknown>, toolNames: Map<string, string>) {
  const message = raw.message
  if (!message || typeof message !== "object") return []
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return []

  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return []
    if (part.type !== "tool_result") return []
    const toolCallId = typeof part.tool_use_id === "string" ? part.tool_use_id : undefined
    const toolName = toolCallId ? toolNames.get(toolCallId) : undefined
    if (!toolCallId || !toolName) return []

    return [
      {
        result: toToolResultOutput(part),
        toolCallId,
        toolName,
      },
    ]
  })
}

function toToolResultOutput(part: Record<string, unknown>) {
  const content = part.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        if (typeof item === "string") return item
        if (!item || typeof item !== "object") return ""
        if (typeof item.text === "string") return item.text
        return JSON.stringify(item)
      })
      .filter(Boolean)
      .join("\n")
    if (text) return text
  }
  return JSON.stringify({ is_error: part.is_error === true, ...(content !== undefined ? { content } : {}) })
}

function parseClaudeCodeLine(line: string) {
  return JSON.parse(line) as Record<string, unknown>
}

function extractString(raw: Record<string, unknown>, path: string[]) {
  let current: unknown = raw
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === "string" ? current : undefined
}

function emptyUsage(): LanguageModelV3Usage {
  return {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  }
}

function toCliError(input: {
  error: unknown
  modelId: string
  provider: string
  requestBodyValues: unknown
}) {
  return new APICallError({
    message: `Claude CLI request failed: ${errorMessage(input.error)}`,
    url: `claude-code://${input.modelId}`,
    requestBodyValues: input.requestBodyValues,
    isRetryable: false,
    responseBody: errorMessage(input.error),
    data: {
      provider: input.provider,
      modelId: input.modelId,
    },
  })
}

function toJsonObject(value: Record<string, unknown>): JSONObject | undefined {
  try {
    return JSON.parse(JSON.stringify(value)) as JSONObject
  } catch {
    return undefined
  }
}
