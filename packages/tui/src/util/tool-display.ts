export function webSearchProviderLabel(provider: unknown) {
  if (provider === "parallel") return "Parallel Web Search"
  if (provider === "exa") return "Exa Web Search"
  return "Web Search"
}

export function toolDisplayMetadata(state: unknown): Record<string, unknown> {
  if (!state || typeof state !== "object" || Array.isArray(state)) return {}
  if (!("status" in state) || state.status === "pending") return {}
  if (!("structured" in state) || !state.structured || typeof state.structured !== "object") return {}
  if (Array.isArray(state.structured)) return {}
  return state.structured as Record<string, unknown>
}

export function formatToolInputSummary(input: Record<string, unknown>, omit?: string[]): string {
  const entries = Object.entries(input)
    .filter(([key, value]) => !omit?.includes(key) && value !== undefined && value !== null && value !== "")
    .map(([key, value]) => {
      if (Array.isArray(value)) return [key, "[...]"]
      if (typeof value === "object") return [key, "{...}"]
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [key, String(value)]
      return undefined
    })
    .filter((entry): entry is [string, string] => entry !== undefined)
  if (entries.length === 0) return ""
  return `[${entries.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}
