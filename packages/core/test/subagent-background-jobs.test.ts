import { expect } from "bun:test"
import path from "path"
import { TestLLM } from "@opencode/ai/testing"
import { Job } from "@opencode/core/job"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { SessionEvent } from "@opencode/core/session/event"
import { Tool } from "@opencode/core/tool"
import { Deferred, Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import type { ConfigExperimental } from "@opencode/schema/config/experimental"
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

const heldChild = Effect.fnUntraced(function* (config?: ConfigExperimental.Info) {
  const fixture = yield* admissionFixtureWithConfig({ full_codemode: true, ...config })
  const { sessions, host, input, parent, llm } = fixture
  const subagent = host.experimental.subagent
  const jobs = yield* Job.Service
  const locations = yield* LocationServiceMap.Service
  const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
  const finish = yield* Deferred.make<void>()
  const replacement = yield* Deferred.make<void>()
  yield* registry.transform((editor) =>
    editor.add({
      name: "hold",
      description: "Wait for release",
      input: Schema.Struct({ replacement: Schema.optionalKey(Schema.Boolean) }),
      execute: (input) => Deferred.await(input.replacement ? replacement : finish).pipe(Effect.as({ content: "done" })),
    }),
  )
  yield* sessions.setPermissions({
    sessionID: parent.id,
    permissions: [{ action: "subagent", resource: "reviewer", effect: "allow" }],
  })
  const prepared = yield* subagent.prepare({ ...input, admissionID: "held-job", target: { kind: "create" } })
  yield* llm.push(
    TestLLM.toolCall("call-script", "execute", { code: "return await tools.hold({})", background: true }),
    TestLLM.stop(),
  )
  const started = yield* subagent.start({
    admissionID: prepared.admissionID,
    prompt: { text: "Start a background job" },
    delivery: "queue",
    mode: "background",
    completion: "parent",
  })
  if (!started.run) throw new Error("Native start omitted its run reference")
  const run = started.run
  yield* sessions.wait(run.childSessionID)
  const job = (yield* jobs.backgroundJobs).find(
    (item) => item.kind === "codemode" && item.sessionID === run.childSessionID && item.status === "running",
  )
  if (!job) throw new Error("Child did not start a Code Mode job")
  const reminders = sessions.context(run.childSessionID).pipe(
    Effect.map((messages) =>
      messages.filter((item) => item.type === "synthetic" && item.metadata?.notice === "subagent-job-reminder"),
    ),
  )
  const leadNotes = sessions.context(parent.id).pipe(
    Effect.map((messages) =>
      messages.filter((item) => item.type === "synthetic" && item.metadata?.notice === "subagent-job-lead-note"),
    ),
  )
  return { ...fixture, run, job, reminders, leadNotes, finish: Deferred.succeed(finish, undefined), subagent }
})

admissionTests.effect("wakes only the child once at the seven-minute threshold", () =>
  Effect.gen(function* () {
    const held = yield* heldChild({ subagent_job_lead_note_minutes: 0 })
    const next = yield* held.llm.gate()
    yield* TestClock.adjust("419999 millis")
    expect(yield* held.reminders).toEqual([])
    yield* TestClock.adjust("1 millis")
    yield* next.started.pipe(Effect.timeout("5 seconds"), TestClock.withLive)
    yield* TestClock.adjust("30 minutes")
    expect(yield* held.reminders).toEqual([
      expect.objectContaining({
        metadata: { notice: "subagent-job-reminder", childID: held.run.childSessionID, jobIDs: [held.job.id] },
        text: expect.stringContaining(`${held.job.id} (codemode, 420s): ${JSON.stringify(held.job.title)}`),
      }),
    ])
    expect(yield* held.sessions.inbox(held.parent.id)).toEqual([])
    yield* next.release
  }),
)

admissionTests.effect("starts a fresh reminder interval when the child resumes and goes idle again", () =>
  Effect.gen(function* () {
    const held = yield* heldChild({ subagent_job_reminder_minutes: 2 })
    yield* TestClock.adjust("1 minute")
    yield* held.sessions.synthetic({ sessionID: held.run.childSessionID, text: "New input" })
    yield* held.sessions.wait(held.run.childSessionID)
    yield* TestClock.adjust("1 minute")
    expect(yield* held.reminders).toEqual([])
    yield* TestClock.adjust("1 minute")
    yield* held.sessions.wait(held.run.childSessionID)
    expect(yield* held.reminders).toHaveLength(1)
  }),
)

admissionTests.effect("wakes the parent once at twenty episode minutes despite two child reminders", () =>
  Effect.gen(function* () {
    const held = yield* heldChild()
    yield* TestClock.adjust("7 minutes")
    yield* held.sessions.wait(held.run.childSessionID)
    expect(yield* held.reminders).toHaveLength(1)
    yield* TestClock.adjust("7 minutes")
    yield* held.sessions.wait(held.run.childSessionID)
    expect(yield* held.reminders).toHaveLength(2)
    yield* TestClock.adjust("359999 millis")
    expect(yield* held.leadNotes).toEqual([])
    yield* TestClock.adjust("1 millis")
    yield* held.sessions.wait(held.parent.id)
    expect(yield* held.leadNotes).toEqual([
      expect.objectContaining({
        metadata: { notice: "subagent-job-lead-note", childID: held.run.childSessionID, jobIDs: [held.job.id] },
        text: expect.stringContaining(`${held.job.id} (${JSON.stringify(held.job.title)}) after 20 minutes`),
      }),
    ])
    yield* TestClock.adjust("21 minutes")
    yield* held.sessions.wait(held.parent.id)
    expect(yield* held.leadNotes).toHaveLength(1)
    expect((yield* held.subagent.get({ run: held.run }))?.status).toBe("running")
  }),
)

admissionTests.effect("starts a fresh lead episode when the child replaces its last job during a turn", () =>
  Effect.gen(function* () {
    const held = yield* heldChild({ subagent_job_reminder_minutes: 0 })
    const jobs = yield* Job.Service
    yield* TestClock.adjust("19 minutes")
    const next = yield* held.llm.gate()
    yield* held.llm.push(
      TestLLM.toolCall("replacement-script", "execute", {
        code: "return await tools.hold({ replacement: true })",
        background: true,
      }),
      TestLLM.stop(),
    )
    yield* held.sessions.synthetic({ sessionID: held.run.childSessionID, text: "Start replacement work" })
    yield* next.started.pipe(Effect.timeout("5 seconds"), TestClock.withLive)
    yield* held.finish
    yield* jobs.wait({ id: held.job.id })
    yield* next.release
    yield* held.sessions.wait(held.run.childSessionID)
    const replacement = (yield* jobs.backgroundJobs).find(
      (item) => item.sessionID === held.run.childSessionID && item.status === "running" && item.id !== held.job.id,
    )
    if (!replacement) throw new Error("Child did not start a replacement job")
    yield* TestClock.adjust("1199999 millis")
    expect(yield* held.leadNotes).toEqual([])
    yield* TestClock.adjust("1 millis")
    yield* held.sessions.wait(held.parent.id)
    expect(yield* held.leadNotes).toEqual([
      expect.objectContaining({
        metadata: { notice: "subagent-job-lead-note", childID: held.run.childSessionID, jobIDs: [replacement.id] },
      }),
    ])
  }),
)

admissionTests.effect("settles normally and cancels pending notices when the last job ends", () =>
  Effect.gen(function* () {
    const held = yield* heldChild()
    yield* TestClock.adjust("6 minutes")
    yield* held.finish
    expect((yield* held.subagent.wait({ run: held.run })).receipt.status).toBe("completed")
    yield* TestClock.adjust("30 minutes")
    expect(yield* held.reminders).toEqual([])
    expect(yield* held.leadNotes).toEqual([])
  }),
)

admissionTests.effect("disables both notices with zero without releasing the held child", () =>
  Effect.gen(function* () {
    const held = yield* heldChild({ subagent_job_reminder_minutes: 0, subagent_job_lead_note_minutes: 0 })
    yield* TestClock.adjust("1 hour")
    expect(yield* held.reminders).toEqual([])
    expect(yield* held.leadNotes).toEqual([])
    expect(yield* held.sessions.inbox(held.parent.id)).toEqual([])
    expect((yield* held.subagent.get({ run: held.run }))?.status).toBe("running")
  }),
)
