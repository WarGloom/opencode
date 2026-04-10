import { Process } from "@/util/process"
import type { ClaudeCodePermissionMode, ClaudeCodeSettingSource } from "./provider"

export interface ClaudeCodeStartInput {
  abortSignal?: AbortSignal
  addDir?: string[]
  bare?: boolean
  binaryPath: string
  cwd: string
  disableSlashCommands?: boolean
  maxTurns?: number
  mcpConfig?: string[]
  modelId: string
  permissionMode?: ClaudeCodePermissionMode
  pluginDir?: string[]
  prompt: string
  settingSources?: ClaudeCodeSettingSource[]
  strictMcpConfig?: boolean
  systemPrompt: string
  tools?: string[]
}

export interface ClaudeCodeExecution {
  command: string[]
  exit: Promise<number>
  lines: AsyncIterable<string>
  stderr: Promise<string>
}

export function startClaudeCodeCommand(input: ClaudeCodeStartInput): ClaudeCodeExecution {
  const maxTurns = Math.max(1, input.maxTurns ?? 8)
  const cmd = [
    input.binaryPath,
    "-p",
    "--model",
    input.modelId,
    "--output-format",
    "stream-json",
    "--input-format",
    "text",
    "--verbose",
    "--include-partial-messages",
    "--max-turns",
    String(maxTurns),
  ]

  if (input.bare) cmd.push("--bare")
  if (input.settingSources && input.settingSources.length > 0) {
    cmd.push("--setting-sources", input.settingSources.join(","))
  }
  if (input.permissionMode) cmd.push("--permission-mode", input.permissionMode)
  if (input.disableSlashCommands) cmd.push("--disable-slash-commands")
  if (input.strictMcpConfig) cmd.push("--strict-mcp-config")
  for (const dir of input.addDir ?? []) cmd.push("--add-dir", dir)
  for (const dir of input.pluginDir ?? []) cmd.push("--plugin-dir", dir)
  for (const cfg of input.mcpConfig ?? []) cmd.push("--mcp-config", cfg)
  if (input.tools !== undefined) cmd.push("--tools", input.tools.join(","))
  const prompt = input.systemPrompt.trim()
    ? `<system>\n${input.systemPrompt.trim()}\n</system>\n\n${input.prompt}`
    : input.prompt

  const proc = Process.spawn(cmd, {
    abort: input.abortSignal,
    cwd: input.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })

  if (proc.stdin) {
    proc.stdin.end(prompt)
  }

  return {
    command: cmd,
    exit: proc.exited,
    lines: iterateLines(proc.stdout),
    stderr: collect(proc.stderr),
  }
}

async function* iterateLines(stream: NodeJS.ReadableStream | null | undefined): AsyncIterable<string> {
  if (!stream) return

  let buf = ""
  try {
    for await (const chunk of stream) {
      buf += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)

      while (true) {
        const idx = buf.indexOf("\n")
        if (idx === -1) break
        const line = buf.slice(0, idx).replace(/\r$/, "")
        buf = buf.slice(idx + 1)
        yield line
      }
    }
  } catch (err) {
    if (!isPrematureClose(err)) throw err
  }

  const line = buf.trim()
  if (line) yield line
}

async function collect(stream: NodeJS.ReadableStream | null | undefined): Promise<string> {
  if (!stream) return ""

  let out = ""
  try {
    for await (const chunk of stream) {
      out += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)
    }
  } catch (err) {
    if (!isPrematureClose(err)) throw err
  }

  return out
}

function isPrematureClose(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ERR_STREAM_PREMATURE_CLOSE"
}
