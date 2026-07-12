/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { onMount } from "solid-js"
import { ArgsProvider, type Args } from "../../../../src/context/args"
import { KVProvider, useKV } from "../../../../src/context/kv"
import { ProjectProvider, useProject } from "../../../../src/context/project"
import { SDKProvider } from "../../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../../src/context/sync"
import { PermissionProvider } from "../../../../src/context/permission"
import { ExitProvider } from "../../../../src/context/exit"
import { createEventSource, createFetch, type FetchHandler, directory, json } from "../../../fixture/tui-sdk"
import { TestTuiContexts } from "../../../fixture/tui-environment"
export { createEventSource, createFetch, directory, eventSource, json, worktree } from "../../../fixture/tui-sdk"

export async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

export function observedJson(data: unknown, observed: () => void) {
  const response = json(data)
  const read = response.text.bind(response)
  Object.defineProperty(response, "text", {
    value: async () => {
      const body = await read()
      observed()
      return body
    },
  })
  return response
}

export const sessionID = "ses_hydration_race"
export const messageID = "msg_hydration_race"
export const partID = "prt_hydration_race"
export const session = {
  id: sessionID,
  slug: "hydration-race",
  projectID: "proj_test",
  title: "race",
  time: { created: 0, updated: 0 },
  version: "1.15.13",
  directory: "/tmp/opencode/packages/opencode",
}
export const assistant = {
  id: messageID,
  sessionID,
  role: "assistant" as const,
  agent: "build",
  modelID: "model",
  providerID: "test",
  mode: "build",
  parentID: "msg_user",
  path: { cwd: session.directory, root: session.directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, completed: 2 },
}

export function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory, project: "proj_test", payload }
}

type Ctx = {
  kv: ReturnType<typeof useKV>
  project: ReturnType<typeof useProject>
  sync: ReturnType<typeof useSync>
}
type BootstrapContext = {
  emit: ReturnType<typeof createEventSource>["emit"]
}

export async function mount(
  override?: FetchHandler,
  state?: string,
  duringBootstrap?: (context: BootstrapContext) => void | Promise<void>,
  args: Args = {},
) {
  const calls = createFetch(override)
  const events = createEventSource()
  const emit = (event: Parameters<typeof events.emit>[0]) => events.emit(event)
  let sync!: ReturnType<typeof useSync>
  let project!: ReturnType<typeof useProject>
  let kv!: ReturnType<typeof useKV>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  function Probe() {
    const ctx: Ctx = { kv: useKV(), project: useProject(), sync: useSync() }
    onMount(() => {
      sync = ctx.sync
      project = ctx.project
      kv = ctx.kv
      done()
    })
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts paths={state ? { state } : undefined}>
      <ArgsProvider {...args}>
        <KVProvider>
          <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
            <PermissionProvider>
              <ProjectProvider>
                <ExitProvider exit={() => {}}>
                  <SyncProvider>
                    <Probe />
                  </SyncProvider>
                </ExitProvider>
              </ProjectProvider>
            </PermissionProvider>
          </SDKProvider>
        </KVProvider>
      </ArgsProvider>
    </TestTuiContexts>
  ))

  await duringBootstrap?.({ emit })
  await ready
  await wait(() => sync.status === "complete")
  return { app, emit, kv, project, sync, session: calls.session }
}
