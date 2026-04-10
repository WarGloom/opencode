import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import { describe, expect, spyOn, test } from "bun:test"

import { ClaudeCodeLanguageModel } from "../../src/provider/sdk/claude-code/language-model"
import { parseClaudeCodeAuthStatus } from "../../src/provider/sdk/claude-code/auth-status"
import { startClaudeCodeCommand } from "../../src/provider/sdk/claude-code/transport"
import { Process } from "../../src/util/process"

const TEST_PROMPT: LanguageModelV3Prompt = [
  { role: "user", content: [{ type: "text", text: "Reply with exactly OK." }] },
]

describe("Claude Code auth status", () => {
  test("parses logged-in status JSON", () => {
    expect(
      parseClaudeCodeAuthStatus(
        JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
          subscriptionType: "max",
        }),
      ),
    ).toEqual({
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      subscriptionType: "max",
    })
  })
})

describe("ClaudeCodeLanguageModel", () => {
  test("streams assistant text and finishes cleanly", async () => {
    const model = new ClaudeCodeLanguageModel("claude-haiku-4-5", {
      binaryPath: "/usr/bin/claude",
      cwd: "/tmp",
      provider: "claude-code",
      start: () => ({
        command: ["claude"],
        lines: (async function* () {
          yield JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Hello" }],
            },
          })
          yield JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Hello world" }],
            },
          })
          yield JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
          })
        })(),
        stderr: Promise.resolve(""),
        exit: Promise.resolve(0),
      }),
    })

    const { stream } = await model.doStream({
      prompt: [...TEST_PROMPT],
      includeRawChunks: false,
    })

    const reader = stream.getReader()
    const parts: unknown[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
    }

    expect(parts).toContainEqual({ type: "text-start", id: "txt-0" })
    expect(parts).toContainEqual({ type: "text-delta", id: "txt-0", delta: "Hello" })
    expect(parts).toContainEqual({ type: "text-delta", id: "txt-0", delta: " world" })
    expect(parts).toContainEqual({ type: "text-end", id: "txt-0" })
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: "finish",
        finishReason: { unified: "stop", raw: "success" },
      }),
    )
  })

  test("generate collects final text output", async () => {
    const model = new ClaudeCodeLanguageModel("claude-haiku-4-5", {
      binaryPath: "/usr/bin/claude",
      cwd: "/tmp",
      provider: "claude-code",
      start: () => ({
        command: ["claude"],
        lines: (async function* () {
          yield JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "OK" }],
            },
          })
          yield JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
          })
        })(),
        stderr: Promise.resolve(""),
        exit: Promise.resolve(0),
      }),
    })

    const result = await model.doGenerate({
      prompt: [...TEST_PROMPT],
    })

    expect(result.content).toEqual([{ type: "text", text: "OK" }])
    expect(result.finishReason).toEqual({ unified: "stop", raw: "success" })
  })

  test("streams Claude native tool calls and results before final text", async () => {
    const model = new ClaudeCodeLanguageModel("claude-haiku-4-5", {
      binaryPath: "/usr/bin/claude",
      cwd: "/tmp",
      provider: "claude-code",
      start: () => ({
        command: ["claude"],
        lines: (async function* () {
          yield JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "toolu_123",
                  name: "Bash",
                  input: { command: "pwd", description: "Print current working directory" },
                },
              ],
            },
          })
          yield JSON.stringify({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_123",
                  content: "/tmp",
                  is_error: false,
                },
              ],
            },
          })
          yield JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "DONE" }],
            },
          })
          yield JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
          })
        })(),
        stderr: Promise.resolve(""),
        exit: Promise.resolve(0),
      }),
    })

    const { stream } = await model.doStream({
      prompt: [...TEST_PROMPT],
      includeRawChunks: false,
    })

    const reader = stream.getReader()
    const parts: unknown[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
    }

    expect(parts).toContainEqual({ type: "tool-input-start", id: "toolu_123", toolName: "Bash" })
    expect(parts).toContainEqual({
      type: "tool-input-delta",
      id: "toolu_123",
      delta: JSON.stringify({ command: "pwd", description: "Print current working directory" }),
    })
    expect(parts).toContainEqual({ type: "tool-input-end", id: "toolu_123" })
    expect(parts).toContainEqual({
      type: "tool-call",
      toolCallId: "toolu_123",
      toolName: "Bash",
      input: JSON.stringify({ command: "pwd", description: "Print current working directory" }),
      providerExecuted: true,
    })
    expect(parts).toContainEqual({
      type: "tool-result",
      toolCallId: "toolu_123",
      toolName: "Bash",
      result: "/tmp",
    })
    expect(parts).toContainEqual({ type: "text-delta", id: "txt-0", delta: "DONE" })
  })

  test("transport forwards runtime hygiene flags", () => {
    let stdinData = ""
    const spawn = spyOn(Process, "spawn").mockImplementation((cmd) => {
      expect(cmd).toEqual([
        "/usr/bin/claude",
        "-p",
        "--model",
        "claude-haiku-4-5",
        "--output-format",
        "stream-json",
        "--input-format",
        "text",
        "--verbose",
        "--include-partial-messages",
        "--max-turns",
        "4",
        "--setting-sources",
        "project,local",
        "--permission-mode",
        "bypassPermissions",
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--add-dir",
        "/tmp/project",
        "--plugin-dir",
        "/tmp/plugin",
        "--mcp-config",
        "/tmp/mcp.json",
        "--tools",
        "Bash,Read",
      ])
      return {
        exited: Promise.resolve(0),
        stderr: null,
        stdout: null,
        stdin: {
          end(data: string) {
            stdinData = data
          },
        },
      } as unknown as Process.Child
    })

    startClaudeCodeCommand({
      addDir: ["/tmp/project"],
      binaryPath: "/usr/bin/claude",
      cwd: "/tmp",
      disableSlashCommands: true,
      maxTurns: 4,
      mcpConfig: ["/tmp/mcp.json"],
      modelId: "claude-haiku-4-5",
      permissionMode: "bypassPermissions",
      pluginDir: ["/tmp/plugin"],
      prompt: "Reply with exactly OK.",
      settingSources: ["project", "local"],
      strictMcpConfig: true,
      systemPrompt: "Stay concise.",
      tools: ["Bash", "Read"],
    })

    expect(stdinData).toBe("<system>\nStay concise.\n</system>\n\nReply with exactly OK.")
    spawn.mockRestore()
  })
})
