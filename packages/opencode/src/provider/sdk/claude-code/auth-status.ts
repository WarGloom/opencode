import { Instance } from "@/project/instance"
import { Process } from "@/util/process"
import { errorMessage } from "@/util/error"

export interface ClaudeCodeAuthStatus {
  loggedIn: boolean
  authMethod?: string
  apiProvider?: string
  subscriptionType?: string
}

export async function getClaudeCodeAuthStatus(binaryPath: string): Promise<ClaudeCodeAuthStatus | undefined> {
  try {
    const result = await Process.text([binaryPath, "auth", "status", "--json"], {
      cwd: Instance.directory,
      timeout: 5_000,
    })
    return parseClaudeCodeAuthStatus(result.text)
  } catch {
    return undefined
  }
}

export function parseClaudeCodeAuthStatus(text: string): ClaudeCodeAuthStatus | undefined {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    return {
      loggedIn: raw.loggedIn === true,
      authMethod: typeof raw.authMethod === "string" ? raw.authMethod : undefined,
      apiProvider: typeof raw.apiProvider === "string" ? raw.apiProvider : undefined,
      subscriptionType: typeof raw.subscriptionType === "string" ? raw.subscriptionType : undefined,
    }
  } catch (error) {
    throw new Error(`Failed to parse Claude Code auth status JSON: ${errorMessage(error)}`)
  }
}
