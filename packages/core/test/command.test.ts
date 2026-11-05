import { describe, expect } from "bun:test"
import { Command } from "@opencode/core/command"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(Command.node))

describe("Command", () => {
  it.effect("registers and executes callback commands", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const calls: Command.Invocation[] = []
      yield* command.transform((editor) => {
        editor.add({
          name: "goal",
          description: "Manage the session goal",
          execute: (input) => Effect.sync(() => calls.push(input)),
        })
      })

      expect(yield* command.get("goal")).toEqual(
        Command.Info.make({ name: "goal", description: "Manage the session goal" }),
      )
      const invocation = {
        invocationID: Command.InvocationID.create(),
        agent: Agent.ID.make("build"),
        sessionID: Session.ID.make("ses_test"),
        prompt: { text: "ship it", files: [{ uri: "file:///tmp/plan.md" }] },
        delivery: "steer" as const,
      }
      yield* command.execute({ name: "goal", invocation })
      expect(calls).toEqual([invocation])
    }),
  )

  it.effect("replaces commands with later definitions", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      yield* command.transform((editor) => {
        editor.add({ name: "goal", description: "First", execute: () => Effect.void })
        editor.add({ name: "goal", description: "Second", execute: () => Effect.void })
      })

      expect(yield* command.list()).toEqual([Command.Info.make({ name: "goal", description: "Second" })])
    }),
  )

  it.effect("returns callback error messages without stack traces", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      yield* command.transform((editor) => {
        editor.add({
          name: "fail",
          execute: () => Effect.fail(new Error("command failed")),
        })
      })

      const error = yield* command
        .execute({
          name: "fail",
          invocation: {
            invocationID: Command.InvocationID.create(),
            agent: Agent.ID.make("build"),
            sessionID: Session.ID.make("ses_test"),
            prompt: { text: "" },
            delivery: "steer",
          },
        })
        .pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "Command.ExecutionError", message: "command failed" })
    }),
  )

  it.effect("resolves only the active canonical invocation", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const invocation = {
        invocationID: Command.InvocationID.create(),
        sessionID: Session.ID.make("ses_test"),
        command: "goal",
        agent: Agent.ID.make("build"),
      }
      expect(
        yield* command.withInvocation(
          invocation,
          command.resolveInvocation({
            kind: "command",
            invocationID: invocation.invocationID,
            command: invocation.command,
            agent: invocation.agent,
          }),
        ),
      ).toEqual(invocation)

      const error = yield* command
        .resolveInvocation({
          kind: "command",
          invocationID: invocation.invocationID,
          command: invocation.command,
          agent: invocation.agent,
        })
        .pipe(Effect.flip)
      expect(error).toMatchObject({
        _tag: "Command.InvalidInvocationError",
        invocationID: invocation.invocationID,
      })
    }),
  )
})
