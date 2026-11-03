import { createHash, randomUUID } from "crypto"
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "fs"
import path from "path"
import { PromptInput } from "@opencode/schema"
import { PromptMention } from "@opencode/schema/prompt"
import { Schema } from "effect"
import { parsePromptInfo, type PromptInfo } from "../../prompt/history"

const retention = 14 * 24 * 60 * 60 * 1000
const delay = 250
const DraftSchema = Schema.Struct({
  ...PromptInput.Prompt.fields,
  files: Schema.optional(Schema.Array(Schema.Struct({ ...PromptInput.FileAttachment.fields, path: Schema.optional(Schema.String) }))),
  pasted: Schema.Array(Schema.Struct({ text: Schema.String, source: PromptMention })),
  mode: Schema.optional(Schema.Literals(["normal", "shell"])),
})

export function createDraftPersistence(state: string) {
  const directory = path.join(state, "prompt-drafts")
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; prompt: PromptInfo }>()
  const file = (sessionID: string | undefined) =>
    path.join(directory, `${sessionID === undefined ? "home" : `session-${createHash("sha256").update(sessionID).digest("hex")}`}.json`)

  function flush(sessionID: string | undefined) {
    const target = file(sessionID)
    const entry = pending.get(target)
    if (!entry) return
    clearTimeout(entry.timer)
    pending.delete(target)
    let temporary: string | undefined
    try {
      mkdirSync(directory, { recursive: true })
      temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
      writeFileSync(temporary, JSON.stringify(entry.prompt), { mode: 0o600 })
      renameSync(temporary, target)
    } catch (error) {
      if (temporary) {
        try {
          rmSync(temporary, { force: true })
        } catch (cleanupError) {
          console.error("Failed to remove temporary prompt draft", cleanupError)
        }
      }
      console.error("Failed to persist prompt draft", error)
    }
  }

  function remove(sessionID: string | undefined) {
    const target = file(sessionID)
    const entry = pending.get(target)
    if (entry) clearTimeout(entry.timer)
    pending.delete(target)
    try {
      rmSync(target, { force: true })
    } catch (error) {
      console.error("Failed to remove prompt draft", error)
    }
  }

  function save(sessionID: string | undefined, prompt: PromptInfo) {
    if (!prompt.text) return remove(sessionID)
    const target = file(sessionID)
    const previous = pending.get(target)
    const snapshot = structuredClone(prompt)
    pending.set(target, { prompt: snapshot, timer: previous?.timer ?? setTimeout(() => flush(sessionID), delay) })
  }

  function read(sessionID: string | undefined) {
    const entry = pending.get(file(sessionID))
    if (entry) return entry.prompt
    try {
      const value: unknown = JSON.parse(readFileSync(file(sessionID), "utf8"))
      if (!Schema.is(DraftSchema)(value)) return
      return parsePromptInfo(value)
    } catch {
      return undefined
    }
  }

  function prune() {
    let files: string[]
    try {
      files = readdirSync(directory)
    } catch {
      return
    }
    for (const name of files) {
      if (!/^(home|session-[a-f0-9]{64})\.json(?:\..*\.tmp)?$/.test(name)) continue
      const target = path.join(directory, name)
      try {
        if (statSync(target).mtimeMs < Date.now() - retention) rmSync(target, { force: true })
      } catch {
        // Another process may have removed or replaced the file.
      }
    }
  }

  prune()
  return { read, save, remove, flush }
}
