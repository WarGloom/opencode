import { createOpenaiCompatible } from "@opencode-ai/core/github-copilot/copilot-provider"
import type { FetchFunction } from "@ai-sdk/provider-utils"
import { describe, expect, test } from "bun:test"

const TEST_PROMPT = [{ role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] }]

function parseJsonRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected JSON object request body")
  }
  return Object.fromEntries(Object.entries(parsed))
}

async function captureStreamBody(modelId: string): Promise<Record<string, unknown>> {
  let capturedBody: Record<string, unknown> | undefined
  const fetch: FetchFunction = Object.assign(
    async (_url: Parameters<FetchFunction>[0], init?: Parameters<FetchFunction>[1]) => {
      capturedBody = parseJsonRecord(String(init?.body))
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: [DONE]\n\n`))
            controller.close()
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      )
    },
    { preconnect() {} },
  )

  await createOpenaiCompatible({
    name: "copilot",
    baseURL: "https://api.test.com",
    fetch,
  })
    .chat(modelId)
    .doStream({
      prompt: TEST_PROMPT,
      includeRawChunks: false,
    })

  if (!capturedBody) throw new Error("Expected request body to be captured")
  return capturedBody
}

describe("Copilot chat request body", () => {
  test("omits stream usage options for Gemini chat models", async () => {
    const body = await captureStreamBody("gemini-2.5-pro")

    expect(body).toMatchObject({
      model: "gemini-2.5-pro",
      stream: true,
    })
    expect(body).not.toHaveProperty("stream_options")
  })

  test("keeps stream usage options for non-Gemini chat models", async () => {
    const body = await captureStreamBody("gpt-5.5")

    expect(body).toHaveProperty("stream_options", { include_usage: true })
  })
})
