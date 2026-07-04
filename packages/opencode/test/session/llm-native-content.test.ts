import { describe, expect } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import type { ModelMessage } from "ai"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import type { Provider } from "@/provider/provider"
import { LLMNative } from "@/session/llm/native-request"
import { testEffect } from "../lib/effect"

const baseModel: Provider.Model = {
  id: ModelV2.ID.make("gpt-5-mini"),
  providerID: ProviderV2.ID.make("openai"),
  api: {
    id: "gpt-5-mini",
    url: "https://api.openai.com/v1",
    npm: "@ai-sdk/openai",
  },
  name: "GPT-5 Mini",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: true,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 128_000,
    input: 128_000,
    output: 32_000,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

const it = testEffect(
  LLMClient.layer.pipe(
    Layer.provide(
      Layer.mergeAll(RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer)), WebSocketExecutor.layer),
    ),
  ),
)

const prepareNativeRequest = (input: Parameters<typeof LLMNative.request>[0]) =>
  LLMClient.prepare(LLMNative.request(input))

describe("session.llm-native.request content tool results", () => {
  it.effect("preserves AI SDK content tool-result media through OpenAI Responses route", () =>
    Effect.gen(function* () {
      const history = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "read",
              input: { filePath: "shot.png" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "read",
              output: {
                type: "content",
                value: [
                  { type: "text", text: "Image read successfully" },
                  { type: "media", mediaType: "image/png", data: "AAECAw==" },
                ],
              },
            },
          ],
        },
      ] satisfies readonly ModelMessage[]

      expect(
        yield* prepareNativeRequest({
          model: baseModel,
          apiKey: "test-openai-key",
          messages: history,
          providerOptions: { openai: { store: false } },
        }),
      ).toMatchObject({
        route: "openai-responses",
        protocol: "openai-responses",
        body: {
          input: [
            {
              type: "function_call",
              call_id: "call-1",
              name: "read",
              arguments: '{"filePath":"shot.png"}',
            },
            {
              type: "function_call_output",
              call_id: "call-1",
              output: [
                { type: "input_text", text: "Image read successfully" },
                { type: "input_image", image_url: "data:image/png;base64,AAECAw==" },
              ],
            },
          ],
          store: false,
        },
      })
    }),
  )
})
