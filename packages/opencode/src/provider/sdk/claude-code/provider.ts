import type { LanguageModelV3 } from "@ai-sdk/provider"

import { Instance } from "@/project/instance"
import { ClaudeCodeLanguageModel } from "./language-model"

export type ClaudeCodePermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "default"
  | "dontAsk"
  | "plan"

export type ClaudeCodeSettingSource = "local" | "project" | "user"

export interface ClaudeCodeProviderSettings {
  addDir?: string[]
  bare?: boolean
  binaryPath: string
  disableSlashCommands?: boolean
  maxTurns?: number
  mcpConfig?: string[]
  name?: string
  permissionMode?: ClaudeCodePermissionMode
  pluginDir?: string[]
  settingSources?: ClaudeCodeSettingSource[]
  strictMcpConfig?: boolean
  tools?: string[]
}

export interface ClaudeCodeProvider {
  (modelId: string): LanguageModelV3
  languageModel(modelId: string): LanguageModelV3
}

export function createClaudeCode(opts: ClaudeCodeProviderSettings): ClaudeCodeProvider {
  const provider = function (modelId: string) {
    return new ClaudeCodeLanguageModel(modelId, {
      addDir: opts.addDir,
      bare: opts.bare,
      binaryPath: opts.binaryPath,
      cwd: Instance.directory,
      disableSlashCommands: opts.disableSlashCommands,
      maxTurns: opts.maxTurns,
      mcpConfig: opts.mcpConfig,
      permissionMode: opts.permissionMode,
      pluginDir: opts.pluginDir,
      provider: opts.name ?? "claude-code",
      settingSources: opts.settingSources,
      strictMcpConfig: opts.strictMcpConfig,
      tools: opts.tools,
    })
  }

  provider.languageModel = provider
  return provider as ClaudeCodeProvider
}
