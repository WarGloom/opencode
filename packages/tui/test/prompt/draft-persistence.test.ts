import { expect, jest, test } from "bun:test"
import { readFile, readdir, utimes, writeFile } from "fs/promises"
import path from "path"
import { createDraftPersistence } from "../../src/component/prompt/draft-persistence"
import { emptyPrompt } from "../../src/prompt/history"
import { tmpdir } from "../fixture/fixture"

test("writes the latest input even while typing continues", async () => {
  await using root = await tmpdir()
  const store = createDraftPersistence(root.path)
  jest.useFakeTimers()
  try {
    store.save(undefined, { ...emptyPrompt(), text: "first" })
    jest.advanceTimersByTime(200)
    store.save(undefined, { ...emptyPrompt(), text: "latest" })
    jest.advanceTimersByTime(50)
    expect(createDraftPersistence(root.path).read(undefined)?.text).toBe("latest")
  } finally {
    jest.useRealTimers()
  }
})

test("persists complete drafts independently across tabs and store instances", async () => {
  await using root = await tmpdir()
  const first = createDraftPersistence(root.path)
  const second = createDraftPersistence(root.path)
  const home = { ...emptyPrompt(), text: "home text", pasted: [{ text: "full text", source: { start: 0, end: 4, text: "home" } }] }
  const session = { ...emptyPrompt(), text: "session text", mode: "shell" as const }
  first.save(undefined, home)
  second.save("home", session)
  first.flush(undefined)
  second.flush("home")
  const restarted = createDraftPersistence(root.path)
  expect(restarted.read(undefined)).toEqual(home)
  expect(restarted.read("home")).toEqual(session)
  expect(restarted.read("other")).toBeUndefined()
})

test("emptying a draft cancels pending writes and removes its file", async () => {
  await using root = await tmpdir()
  const store = createDraftPersistence(root.path)
  store.save("session", { ...emptyPrompt(), text: "first" })
  store.flush("session")
  store.save("session", { ...emptyPrompt(), text: "second" })
  store.save("session", emptyPrompt())
  store.flush("session")
  expect(createDraftPersistence(root.path).read("session")).toBeUndefined()
})

test("ignores corrupt drafts and prunes old files on startup", async () => {
  await using root = await tmpdir()
  const store = createDraftPersistence(root.path)
  store.save(undefined, { ...emptyPrompt(), text: "old" })
  store.save("keep", { ...emptyPrompt(), text: "keep" })
  store.flush(undefined)
  store.flush("keep")
  const dir = path.join(root.path, "prompt-drafts")
  const home = path.join(dir, "home.json")
  const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000)
  await utimes(home, old, old)
  const restarted = createDraftPersistence(root.path)
  expect(restarted.read(undefined)).toBeUndefined()
  expect(restarted.read("keep")?.text).toBe("keep")
  const remaining = await readdir(dir)
  expect(remaining).toHaveLength(1)
  const name = remaining[0]
  if (!name) throw new Error("expected the retained draft")
  const target = path.join(dir, name)
  expect(await readFile(target, "utf8")).toContain("keep")
  await writeFile(target, "{invalid json")
  expect(restarted.read("keep")).toBeUndefined()
  await writeFile(target, JSON.stringify({ text: "invalid", pasted: [null] }))
  expect(restarted.read("keep")).toBeUndefined()
})
