export * as SkillTool from "./skill.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure } from "@opencode/ai/effect"
import { Effect, Schema } from "effect"
import { ActivationID } from "@opencode/schema/skill"
import path from "path"
import { Skill } from "../../skill.js"
import { Session } from "../../session.js"

export const name = "skill"

export const Input = Schema.Struct({
  id: Skill.ID.annotate({ description: "The ID of an available skill or a skill explicitly referenced by the user" }),
})

export const Output = Schema.Struct({
  name: Skill.Name,
  directory: Schema.String,
  output: Schema.String,
})
export const description = [
  "Load a specialized skill's instructions and resources into the current conversation when the task at hand matches its description.",
  "",
  "The skill ID must match an available skill or a skill explicitly referenced by the user.",
].join("\n")

export const toModelOutput = Skill.toModelOutput

const unableToLoad = (name: string, error?: unknown) =>
  new ToolFailure({ message: `Unable to load skill ${name}`, error })

export const Plugin = {
  id: "opencode.tool.skill",
  effect: Effect.fn("SkillTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const activation = yield* sessions.skill({
                sessionID: context.sessionID,
                activationID: ActivationID.make(
                  `ska_${new Bun.CryptoHasher("sha256").update(`${context.messageID}:${context.id}`).digest("hex").slice(0, 24)}`,
                ),
                messageID: context.messageID,
                source: { kind: "tool", messageID: context.messageID, callID: context.id },
                skill: input.id,
                resume: false,
              }).pipe(Effect.mapError((error) => unableToLoad(input.id, error)))
              return {
                name: activation.skill.name,
                directory: Skill.isUri(activation.skill.path) ? Skill.uri(activation.skill.id) : path.dirname(activation.skill.path),
                output: activation.content,
              }
            }).pipe(
              Effect.map((output) => ({
                output,
                content: output.output,
                metadata: { name: output.name, directory: output.directory },
              })),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
