import type { Message, UserMessage } from "@opencode-ai/sdk/v2"

export function visibleUserMessages(messages: readonly Message[]): UserMessage[] {
  const seen = new Set<string>()
  return messages.flatMap((message) => {
    if (message.role !== "user") return []
    if (seen.has(message.id)) return []
    seen.add(message.id)
    return [message as UserMessage]
  })
}
