import { createProviderToolFactory } from "@ai-sdk/provider-utils"
import { z } from "zod"
import type { Provider } from "@/provider/provider"

const DEFAULT_ADVISOR_MODEL = "claude-opus-4-7"
const VALID_ADVISOR_PATTERNS = [
  "claude-opus-4-7",
  "claude-opus-4-8",
] as const
const VALID_EXECUTOR_PATTERNS = [
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
] as const

const anthropicAdvisorFactory = createProviderToolFactory<
  Record<string, never>,
  {
    model: string
    maxUses?: number
    caching?: { type: "ephemeral"; ttl: "5m" | "1h" }
  }
>({
  id: "anthropic.advisor_20260301",
  inputSchema: z.object({}),
})

export type AnthropicAdvisorConfig = {
  model: string
  maxUses?: number
  caching?: { type: "ephemeral"; ttl: "5m" | "1h" }
}

function stripProviderPrefix(modelID: string): string {
  const parts = modelID.split("/")
  return parts.length > 1 ? parts.slice(1).join("/") : modelID
}

function isValidAdvisorModel(modelID: string): boolean {
  const normalized = stripProviderPrefix(modelID)
  return VALID_ADVISOR_PATTERNS.some((pattern) => normalized.includes(pattern))
}

function isValidExecutorModel(modelID: string): boolean {
  const normalized = stripProviderPrefix(modelID)
  return VALID_EXECUTOR_PATTERNS.some((pattern) => normalized.includes(pattern))
}

function normalizeAnthropicAdvisorConfig(value: unknown): AnthropicAdvisorConfig | undefined {
  if (value == null || value === false) return undefined
  if (value === true) return { model: DEFAULT_ADVISOR_MODEL }
  if (typeof value !== "object") {
    throw new Error("anthropicAdvisor must be a boolean or object")
  }

  const record = value as Record<string, unknown>
  if (record.enabled === false) return undefined

  const model = typeof record.model === "string" && record.model.length > 0
    ? record.model
    : DEFAULT_ADVISOR_MODEL

  const maxUses = record.maxUses
  if (maxUses !== undefined && (!Number.isInteger(maxUses) || Number(maxUses) <= 0)) {
    throw new Error("anthropicAdvisor.maxUses must be a positive integer")
  }

  const caching = record.caching
  if (caching !== undefined) {
    if (typeof caching !== "object" || caching == null) {
      throw new Error("anthropicAdvisor.caching must be an object")
    }
    const ttl = (caching as Record<string, unknown>).ttl
    if (ttl !== "5m" && ttl !== "1h") {
      throw new Error("anthropicAdvisor.caching.ttl must be '5m' or '1h'")
    }
    return {
      model,
      ...(maxUses !== undefined ? { maxUses: Number(maxUses) } : {}),
      caching: { type: "ephemeral", ttl },
    }
  }

  return {
    model,
    ...(maxUses !== undefined ? { maxUses: Number(maxUses) } : {}),
  }
}

export function extractAnthropicAdvisorConfig(
  options: Record<string, any>,
): { advisor?: AnthropicAdvisorConfig; providerOptions: Record<string, any> } {
  const { anthropicAdvisor, ...providerOptions } = options
  const advisor = normalizeAnthropicAdvisorConfig(anthropicAdvisor)
  return { advisor, providerOptions }
}

export function validateAnthropicAdvisorPair(
  executorModel: Provider.Model,
  advisor: AnthropicAdvisorConfig,
): void {
  if (!isValidAdvisorModel(advisor.model)) {
    throw new Error(`Unsupported anthropic advisor model: ${advisor.model}`)
  }

  if (!isValidExecutorModel(executorModel.api.id) && !isValidExecutorModel(executorModel.id)) {
    throw new Error(
      `Unsupported anthropic advisor executor model: ${executorModel.id}. `
      + "Supported executors currently include Claude Haiku 4.5, Claude Sonnet 4.6, Claude Opus 4.6, Claude Opus 4.7, and Claude Opus 4.8.",
    )
  }
}

export function createAnthropicAdvisorTool(advisor: AnthropicAdvisorConfig) {
  return anthropicAdvisorFactory({
    model: stripProviderPrefix(advisor.model),
    ...(advisor.maxUses !== undefined ? { maxUses: advisor.maxUses } : {}),
    ...(advisor.caching ? { caching: advisor.caching } : {}),
  })
}
