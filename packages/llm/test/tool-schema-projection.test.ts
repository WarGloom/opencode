import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLM } from "../src"
import { OpenAIChat } from "../src/protocols"
import { ToolSchemaProjection } from "../src/protocols/utils/tool-schema"
import { Auth, LLMClient } from "../src/route"
import { it } from "./lib/effect"

describe("tool schema projections", () => {
  test("moonshot strips $ref siblings and converts tuple arrays to a schema object", () => {
    expect(
      ToolSchemaProjection.moonshot({
        type: "object",
        properties: {
          linked: { $ref: "#/$defs/Linked", description: "drop me" },
          tuple: { type: "array", items: [{ type: "string" }, { type: "number" }] },
          prefixTuple: { type: "array", prefixItems: [{ type: "boolean" }, { type: "string" }] },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        linked: { $ref: "#/$defs/Linked" },
        tuple: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } },
        prefixTuple: { type: "array", items: { anyOf: [{ type: "boolean" }, { type: "string" }] } },
      },
    })
  })

  test("gemini handles numeric enums, dangling required fields, untyped arrays, and scalar object keys", () => {
    expect(
      ToolSchemaProjection.gemini({
        type: "object",
        required: ["status", "missing"],
        properties: {
          status: { type: "integer", enum: [1, 2] },
          tags: { type: "array" },
          name: { type: "string", properties: { ignored: { type: "string" } }, required: ["ignored"] },
        },
      }),
    ).toEqual({
      type: "object",
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["1", "2"] },
        tags: { type: "array", items: { type: "string" } },
        name: { type: "string" },
      },
    })
  })

  test("gemini preserves required-only alias branches as valid object schemas", () => {
    expect(
      ToolSchemaProjection.gemini({
        type: "object",
        properties: {
          changes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                operation: { type: "string" },
                op: { type: "string" },
                action: { type: "string" },
              },
              required: ["path"],
              anyOf: [{ required: ["operation"] }, { required: ["op"] }, { required: ["action"] }],
            },
          },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              operation: { type: "string" },
              op: { type: "string" },
              action: { type: "string" },
            },
            required: ["path"],
            anyOf: [
              {
                type: "object",
                properties: { operation: { type: "string" } },
                required: ["operation"],
              },
              {
                type: "object",
                properties: { op: { type: "string" } },
                required: ["op"],
              },
              {
                type: "object",
                properties: { action: { type: "string" } },
                required: ["action"],
              },
            ],
          },
        },
      },
    })
  })

  test("gemini drops malformed required values and inherited property names", () => {
    const stringRequired: Record<string, unknown> = {}
    Object.defineProperty(stringRequired, "required", { value: "own", enumerable: true })
    const objectRequired: Record<string, unknown> = {}
    Object.defineProperty(objectRequired, "required", { value: { field: "own" }, enumerable: true })
    const nonStringRequired: Record<string, unknown> = {}
    Object.defineProperty(nonStringRequired, "required", { value: [42], enumerable: true })
    const items: Record<string, unknown> = {
      type: "object",
      properties: { own: { type: "string" } },
      anyOf: [stringRequired, objectRequired, nonStringRequired],
    }
    Object.defineProperty(items, "required", { value: ["own", "toString", 42], enumerable: true })

    expect(
      ToolSchemaProjection.gemini({
        type: "object",
        properties: {
          changes: {
            type: "array",
            items,
          },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        changes: {
          type: "array",
          items: {
            type: "object",
            properties: { own: { type: "string" } },
            required: ["own"],
            anyOf: [{}, {}, {}],
          },
        },
      },
    })
  })

  test("openai keeps one flat object top-level schema", () => {
    expect(
      ToolSchemaProjection.openAI({
        anyOf: [
          {
            type: "object",
            properties: {
              path: { type: "string" },
              maybe: { anyOf: [{ type: "string" }, { type: "null" }] },
            },
          },
          { type: "object", properties: { resource: { type: "string" } } },
        ],
      }),
    ).toEqual({
      type: "object",
      properties: {
        path: { type: "string" },
        maybe: { type: "string" },
        resource: { type: "string" },
      },
      additionalProperties: false,
    })
  })

  it.effect("applies model compatibility before protocol projection", () =>
    Effect.gen(function* () {
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
        .model({ id: "kimi-k2", compatibility: { toolSchema: "moonshot" } })
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          prompt: "Use the tool.",
          tools: [
            {
              name: "lookup",
              description: "Lookup data.",
              inputSchema: {
                type: "object",
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      tuple: { type: "array", items: [{ type: "string" }, { type: "number" }] },
                      linked: { $ref: "#/$defs/Linked", description: "drop me" },
                    },
                  },
                ],
              },
            },
          ],
        }),
      )

      expect(prepared.body.tools?.[0]?.function.parameters).toEqual({
        type: "object",
        properties: {
          tuple: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } },
          linked: { $ref: "#/$defs/Linked" },
        },
        additionalProperties: false,
      })
    }),
  )
})
