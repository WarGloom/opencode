import { expect, test } from "bun:test"
import { createDraftPersistence } from "../../src/component/prompt/draft-persistence"
import { flushDraft, takeDraft } from "../../src/component/prompt/draft-stash"
import { emptyPrompt } from "../../src/prompt/history"
import { createAppFixture } from "../fixture/app"
import { tmpdir } from "../fixture/fixture"
import { json } from "../fixture/tui-client"

test("the composer restores a disk draft and removes drafts on clear and submit", async () => {
  await using root = await tmpdir()
  const disk = createDraftPersistence(root.path)
  disk.save(undefined, { ...emptyPrompt(), text: "restored draft" })
  disk.flush(undefined)
  takeDraft(undefined)
  const location = {
    directory: "/tmp/opencode/packages/tui",
    project: { id: "project", directory: "/tmp/opencode", canonical: "/tmp/opencode" },
  }
  const submitted = Promise.withResolvers<void>()
  await using setup = await createAppFixture({
    state: root.path,
    args: { newSessionID: "ses_draft_test" },
    config: { animations: false, keybinds: { "prompt.clear": "ctrl+l" } },
    fetch: async (url, request) => {
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "demo", name: "Demo Model", variants: [] }] })
      if (url.pathname === "/api/session" && request.method === "POST") {
        const record = await request.json()
        return json({ data: { ...record, location: { directory: location.directory }, projectID: "project", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 0, updated: 0 } } })
      }
      if (url.pathname === "/api/session/ses_draft_test/prompt") {
        submitted.resolve()
        return json({ data: {} })
      }
      if (/^\/api\/session\/[^/]+\/(agent|model)$/.test(url.pathname)) return new Response(null, { status: 204 })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname)) return json({ data: [], cursor: {} })
      return undefined
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("restored draft") && frame.includes("Demo Model"))
  expect(setup.renderer.currentFocusedEditor?.plainText).toBe("restored draft")
  setup.mockInput.pressKey("l", { ctrl: true })
  await setup.waitForFrame(() => setup.renderer.currentFocusedEditor?.plainText === "")
  expect(disk.read(undefined)).toBeUndefined()

  await setup.mockInput.typeText("send this draft")
  await setup.waitForFrame(() => setup.renderer.currentFocusedEditor?.plainText === "send this draft")
  flushDraft(undefined)
  expect(disk.read(undefined)?.text).toBe("send this draft")
  setup.mockInput.pressEnter()
  await submitted.promise
  expect(disk.read(undefined)).toBeUndefined()
})
