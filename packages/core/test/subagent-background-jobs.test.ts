import { expect } from "bun:test"
import path from "path"
import { TestLLM } from "@opencode/ai/testing"
import { Job } from "@opencode/core/job"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { SessionEvent } from "@opencode/core/session/event"
import { Tool } from "@opencode/core/tool"
import { Deferred, Effect, Schema } from "effect"
import { admissionFixtureWithConfig, admissionTests } from "./fixture/subagent-admission"

for (const scenario of ["shell completes", "Code Mode completes", "Code Mode cancels", "child cancels"] as const) {
  admissionTests.live(`settles the delegated child only when ${scenario}`, () =>
    Effect.gen(function* () {
      const codeMode = scenario.startsWith("Code Mode")
      const { sessions, host, input, parent, llm, bus } = yield* admissionFixtureWithConfig({ full_codemode: codeMode })
      const subagent = host.experimental.subagent
      const jobs = yield* Job.Service
      const release = path.join(parent.location.directory, "release")
      const command =
        process.platform === "win32"
          ? `while (!(Test-Path -LiteralPath '${release}')) { Start-Sleep -Milliseconds 25 }; Write-Output done`
          : `while [ ! -e '${release}' ]; do sleep 0.025; done; printf done`
      const finish = yield* Deferred.make<void>()
      if (codeMode) {
        const locations = yield* LocationServiceMap.Service
        const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
        yield* registry.transform((editor) =>
          editor.add({
            name: "hold",
            description: "Wait for release",
            input: Schema.Struct({}),
            execute: () => Deferred.await(finish).pipe(Effect.as({ content: "done" })),
          }),
        )
      } else {
        yield* Effect.addFinalizer(() => Effect.promise(() => Bun.write(release, "go")))
      }
      yield* sessions.setPermissions({
        sessionID: parent.id,
        permissions: [{ action: "subagent", resource: "reviewer", effect: "allow" }],
      })
      const prepared = yield* subagent.prepare({ ...input, admissionID: "shell-job", target: { kind: "create" } })
      const parentWake = yield* Deferred.make<void>()
      let parentWakes = 0
      const unsubscribe = yield* bus.listen((event) => {
        if (event.type !== SessionEvent.Execution.Started.type || event.durable?.aggregateID !== parent.id)
          return Effect.void
        parentWakes++
        return Deferred.succeed(parentWake, undefined).pipe(Effect.asVoid)
      })
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* llm.push(
        codeMode
          ? TestLLM.toolCall("call-script", "execute", { code: "return await tools.hold({})", background: true })
          : TestLLM.toolCall("call-shell", "shell", { command, background: true }),
        TestLLM.stop(),
        TestLLM.text("Job result received", "job-result"),
      )
      const started = yield* subagent.start({
        admissionID: prepared.admissionID,
        prompt: { text: "Run the shell command" },
        delivery: "queue",
        mode: "background",
        completion: "parent",
      })
      if (!started.run) throw new Error("Native start omitted its run reference")
      const run = started.run
      yield* sessions.wait(run.childSessionID)
      const job = (yield* jobs.pendingBackground).find(
        ({ recovery }) =>
          (recovery.kind === "codemode" || recovery.kind === "shell") && recovery.sessionID === run.childSessionID,
      )
      expect(job).toMatchObject({ status: "running", recovery: { kind: codeMode ? "codemode" : "shell" } })
      if (!job) throw new Error("Child did not start a background job")
      expect(yield* subagent.wait({ run, timeout: 100 })).toMatchObject({
        timedOut: true,
        receipt: { status: "running" },
      })
      expect(parentWakes).toBe(0)
      expect(yield* sessions.inbox(parent.id)).toEqual([])

      if (scenario === "child cancels") yield* jobs.cancel(run.childSessionID, run.generation)
      if (scenario === "Code Mode cancels") yield* jobs.cancel(job.id)
      if (scenario === "Code Mode completes") yield* Deferred.succeed(finish, undefined)
      if (scenario === "shell completes") yield* Effect.promise(() => Bun.write(release, "go"))

      const status = scenario === "child cancels" ? "cancelled" : "completed"
      expect((yield* subagent.wait({ run }).pipe(Effect.timeout("5 seconds"))).receipt).toMatchObject({
        status,
        ...(status === "completed" ? { output: "Job result received" } : {}),
      })
      yield* Deferred.await(parentWake).pipe(Effect.timeout("5 seconds"))
      yield* sessions.wait(parent.id)
      const delivered = yield* sessions.context(parent.id)
      const queued = yield* sessions.inbox(parent.id)
      expect(parentWakes).toBe(1)
      expect([
        ...delivered.flatMap((message) => (message.type === "synthetic" ? [message.metadata] : [])),
        ...queued.flatMap((item) => (item.type === "synthetic" ? [item.payload.metadata] : [])),
      ]).toEqual([expect.objectContaining({ source: "subagent", childID: run.childSessionID, state: status })])
    }),
  )
}
