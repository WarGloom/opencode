import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Command,
  PermissionRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
  SnapshotFileDiff,
  ConsoleState,
} from "@opencode-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { useProject } from "./project"
import { useEvent } from "./event"
import { useSDK } from "./sdk"
import { useTuiStartup } from "./runtime"
import { createSimpleContext } from "./helper"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, onMount } from "solid-js"
import path from "path"
import { useKV } from "./kv"
import { usePermission } from "./permission"

const emptyConsoleState: ConsoleState = {
  consoleManagedProviders: [],
  switchableOrgCount: 0,
}

function search<T>(items: T[], target: string, key: (item: T) => string) {
  let left = 0
  let right = items.length - 1
  while (left <= right) {
    const middle = Math.floor((left + right) / 2)
    const value = key(items[middle])
    if (value === target) return { found: true, index: middle }
    if (value < target) left = middle + 1
    else right = middle - 1
  }
  return { found: false, index: left }
}

function compareMessage(a: Message, b: Message) {
  return a.time.created - b.time.created || a.id.localeCompare(b.id)
}

const messageKey = (message: Message) => message.time.created + message.id

export const {
  context: SyncContext,
  use: useSync,
  provider: SyncProvider,
} = createSimpleContext({
  name: "Sync",
  init: () => {
    const startup = useTuiStartup()
    const kv = useKV()
    const permission = usePermission()
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      console_state: ConsoleState
      capabilities: {
        experimentalBackgroundSubagents: boolean
      }
      provider_auth: Record<string, ProviderAuthMethod[]>
      agent: Agent[]
      command: Command[]
      permission: {
        [sessionID: string]: PermissionRequest[]
      }
      question: {
        [sessionID: string]: QuestionRequest[]
      }
      config: Config
      session: Session[]
      session_status: {
        [sessionID: string]: SessionStatus
      }
      session_diff: {
        [sessionID: string]: SnapshotFileDiff[]
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      message: {
        [sessionID: string]: Message[]
      }
      part: {
        [messageID: string]: Part[]
      }
      lsp: LspStatus[]
      mcp: {
        [key: string]: McpStatus
      }
      mcp_resource: {
        [key: string]: McpResource
      }
      formatter: FormatterStatus[]
      vcs: VcsInfo | undefined
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      console_state: emptyConsoleState,
      capabilities: {
        experimentalBackgroundSubagents: false,
      },
      provider_auth: {},
      config: {},
      status: "loading",
      agent: [],
      permission: {},
      question: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      session_diff: {},
      todo: {},
      message: {},
      part: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      vcs: undefined,
    })

    const event = useEvent()
    const project = useProject()
    const sdk = useSDK()

    const fullSyncedSessions = new Set<string>()
    const syncingSessions = new Map<string, Promise<void>>()
    const sessionChanges = new Map<
      string,
      {
        messages: Set<string>
        parts: Set<string>
        session: boolean
        todo: boolean
        diff: boolean
        deleted: boolean
      }
    >()
    const sessionMutations = new Map<string, { sequence: number; generation: number; info?: Session }>()
    const statusMutations = new Map<string, number>()
    const statusHydrations = new Set<Map<string, number>>()
    let sessionListGeneration = 0
    let sessionMutationSequence = 0
    let statusMutationSequence = 0
    const change = (sessionID: string) => {
      const existing = sessionChanges.get(sessionID)
      if (existing) return existing
      const created = {
        messages: new Set<string>(),
        parts: new Set<string>(),
        session: false,
        todo: false,
        diff: false,
        deleted: false,
      }
      sessionChanges.set(sessionID, created)
      return created
    }
    const touchMessage = (sessionID: string, messageID: string) => {
      if (fullSyncedSessions.has(sessionID)) return
      change(sessionID).messages.add(messageID)
    }
    const touchPart = (sessionID: string, partID: string) => {
      if (fullSyncedSessions.has(sessionID)) return
      change(sessionID).parts.add(partID)
    }
    const touchStatus = (sessionID: string) => {
      const sequence = ++statusMutationSequence
      statusMutations.set(sessionID, sequence)
      for (const hydration of statusHydrations) hydration.set(sessionID, sequence)
    }

    function sessionListQuery(): { scope?: "project"; path?: string } {
      if (!kv.get("session_directory_filter_enabled", true)) return { scope: "project" }
      if (!project.data.instance.path.worktree || !project.data.instance.path.directory) return { scope: "project" }
      return {
        path: path
          .relative(path.resolve(project.data.instance.path.worktree), project.data.instance.path.directory)
          .replaceAll("\\", "/"),
      }
    }

    async function listSessions() {
      const generation = ++sessionListGeneration
      const response = await sdk.client.session.list({
        start: Date.now() - 30 * 24 * 60 * 60 * 1000,
        ...sessionListQuery(),
      })
      return { generation, sessions: response.data ?? [] }
    }

    function mergeSessionList(snapshot: Awaited<ReturnType<typeof listSessions>>) {
      const sessions = new Map(snapshot.sessions.map((session) => [session.id, session]))
      for (const [sessionID, mutation] of sessionMutations) {
        if (mutation.info) sessions.set(sessionID, mutation.info)
        if (!mutation.info) sessions.delete(sessionID)
      }
      return [...sessions.values()].toSorted((a, b) => a.id.localeCompare(b.id))
    }

    function applySessionList(snapshot: Awaited<ReturnType<typeof listSessions>>) {
      if (snapshot.generation !== sessionListGeneration) return
      setStore("session", reconcile(mergeSessionList(snapshot)))
      const listed = new Map(snapshot.sessions.map((session) => [session.id, session]))
      for (const [sessionID, mutation] of sessionMutations) {
        if (sessionMutations.get(sessionID) !== mutation) continue
        // A mutation journaled while this snapshot's list request was already in
        // flight could not have been reflected by it, so only a strictly newer
        // list generation is allowed to acknowledge (and prune) it.
        if (snapshot.generation <= mutation.generation) continue
        if (mutation.info && JSON.stringify(listed.get(sessionID)) !== JSON.stringify(mutation.info)) continue
        if (!mutation.info && listed.has(sessionID)) continue
        sessionMutations.delete(sessionID)
      }
    }

    function removeSession(sessionID: string) {
      sessionMutations.set(sessionID, { sequence: ++sessionMutationSequence, generation: sessionListGeneration })
      const hydration = sessionChanges.get(sessionID)
      if (hydration) hydration.deleted = true
      touchStatus(sessionID)
      fullSyncedSessions.delete(sessionID)
      setStore(
        produce((draft) => {
          const result = search(draft.session, sessionID, (session) => session.id)
          if (result.found) draft.session.splice(result.index, 1)
          for (const message of draft.message[sessionID] ?? []) delete draft.part[message.id]
          for (const [messageID, parts] of Object.entries(draft.part)) {
            if (parts.some((part) => part.sessionID === sessionID)) delete draft.part[messageID]
          }
          delete draft.message[sessionID]
          delete draft.todo[sessionID]
          delete draft.session_diff[sessionID]
          delete draft.permission[sessionID]
          delete draft.question[sessionID]
          delete draft.session_status[sessionID]
        }),
      )
    }

    event.subscribe((event, { directory, project: eventProject, workspace }) => {
      const query = sessionListQuery()
      if (project.data.project.id && eventProject && project.data.project.id !== eventProject) return
      if (workspace !== undefined && workspace !== project.workspace.current()) return
      if (
        query.path !== undefined &&
        path.resolve(project.data.instance.path.worktree, query.path) !== path.resolve(directory)
      )
        return
      switch (event.type) {
        case "server.instance.disposed":
          void bootstrap()
          break
        case "permission.replied": {
          const requests = store.permission[event.properties.sessionID]
          if (!requests) break
          const match = search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "permission",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "permission.asked": {
          const request = event.properties
          if (permission.mode === "auto") {
            void sdk.client.permission.reply({
              requestID: request.id,
              reply: "once",
              directory,
              workspace,
            })
            break
          }
          const requests = store.permission[request.sessionID]
          if (!requests) {
            setStore("permission", request.sessionID, [request])
            break
          }
          const match = search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("permission", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "permission",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "question.replied":
        case "question.rejected": {
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "question",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "question.asked": {
          const request = event.properties
          const requests = store.question[request.sessionID]
          if (!requests) {
            setStore("question", request.sessionID, [request])
            break
          }
          const match = search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("question", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "question",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "todo.updated":
          if (!fullSyncedSessions.has(event.properties.sessionID)) change(event.properties.sessionID).todo = true
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        case "session.diff":
          if (!fullSyncedSessions.has(event.properties.sessionID)) change(event.properties.sessionID).diff = true
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        case "session.deleted": {
          removeSession(event.properties.info.id)
          break
        }
        case "session.created":
        case "session.updated": {
          if (!fullSyncedSessions.has(event.properties.info.id)) change(event.properties.info.id).session = true
          sessionMutations.set(event.properties.info.id, {
            sequence: ++sessionMutationSequence,
            generation: sessionListGeneration,
            info: event.properties.info,
          })
          const result = search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        case "session.next.moved": {
          if (!fullSyncedSessions.has(event.properties.sessionID)) change(event.properties.sessionID).session = true
          const result = search(store.session, event.properties.sessionID, (s) => s.id)
          if (!result.found) break
          const moved = {
            ...store.session[result.index],
            directory: event.properties.location.directory,
            path: event.properties.subdirectory,
            workspaceID: event.properties.location.workspaceID,
            time: { ...store.session[result.index].time, updated: event.properties.timestamp },
          }
          sessionMutations.set(event.properties.sessionID, {
            sequence: ++sessionMutationSequence,
            generation: sessionListGeneration,
            info: moved,
          })
          setStore("session", result.index, reconcile(moved))
          break
        }

        case "session.status": {
          touchStatus(event.properties.sessionID)
          setStore("session_status", event.properties.sessionID, event.properties.status)
          if (event.properties.status.type === "idle" && !syncingSessions.has(event.properties.sessionID)) {
            sessionChanges.delete(event.properties.sessionID)
          }
          break
        }

        case "message.updated": {
          touchMessage(event.properties.info.sessionID, event.properties.info.id)
          const messages = store.message[event.properties.info.sessionID]
          if (!messages) {
            setStore("message", event.properties.info.sessionID, [event.properties.info])
            break
          }
          const result = search(messages, messageKey(event.properties.info), messageKey)
          if (result.found) {
            setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "message",
            event.properties.info.sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          const updated = store.message[event.properties.info.sessionID]
          if (updated.length > 100) {
            const oldest = updated[0]
            batch(() => {
              setStore(
                "message",
                event.properties.info.sessionID,
                produce((draft) => {
                  draft.shift()
                }),
              )
              setStore(
                "part",
                produce((draft) => {
                  delete draft[oldest.id]
                }),
              )
            })
          }
          break
        }
        case "message.removed": {
          touchMessage(event.properties.sessionID, event.properties.messageID)
          setStore(
            produce((draft) => {
              const messages = draft.message[event.properties.sessionID]
              if (messages) {
                const result = search(messages, event.properties.messageID, (message) => message.id)
                if (result.found) messages.splice(result.index, 1)
              }
              delete draft.part[event.properties.messageID]
            }),
          )
          break
        }
        case "message.part.updated": {
          touchPart(event.properties.part.sessionID, event.properties.part.id)
          const parts = store.part[event.properties.part.messageID]
          if (!parts) {
            setStore("part", event.properties.part.messageID, [event.properties.part])
            break
          }
          const result = search(parts, event.properties.part.id, (part) => part.id)
          if (result.found) {
            setStore("part", event.properties.part.messageID, result.index, reconcile(event.properties.part))
            break
          }
          setStore(
            "part",
            event.properties.part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.part)
            }),
          )
          break
        }

        case "message.part.delta": {
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = search(parts, event.properties.partID, (part) => part.id)
          if (!result.found) break
          touchPart(event.properties.sessionID, event.properties.partID)
          setStore(
            "part",
            event.properties.messageID,
            produce((draft) => {
              const part = draft[result.index]
              const field = event.properties.field as keyof typeof part
              const existing = part[field] as string | undefined
              ;(part[field] as string) = (existing ?? "") + event.properties.delta
            }),
          )
          break
        }

        case "message.part.removed": {
          touchPart(event.properties.sessionID, event.properties.partID)
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = search(parts, event.properties.partID, (part) => part.id)
          if (result.found) {
            setStore(
              produce((draft) => {
                const parts = draft.part[event.properties.messageID]
                if (!parts) return
                const result = search(parts, event.properties.partID, (part) => part.id)
                if (!result.found) return
                parts.splice(result.index, 1)
                if (parts.length === 0) delete draft.part[event.properties.messageID]
              }),
            )
          }
          break
        }

        case "lsp.updated": {
          const workspace = project.workspace.current()
          void sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", x.data ?? []))
          break
        }

        case "vcs.branch.updated": {
          if (workspace === project.workspace.current()) {
            setStore("vcs", { branch: event.properties.branch })
          }
          break
        }
      }
    })

    const exit = useExit()
    const args = useArgs()

    async function bootstrap(input: { fatal?: boolean } = {}) {
      const fatal = input.fatal ?? true
      const workspace = project.workspace.current()
      const projectPromise = project.sync()
      const sessionListPromise = projectPromise.then(() => listSessions())

      // blocking - include session.list when continuing a session
      const providersPromise = sdk.client.config.providers({ workspace }, { throwOnError: true })
      const providerListPromise = sdk.client.provider.list({ workspace }, { throwOnError: true })
      const capabilitiesPromise = sdk.client.experimental.capabilities
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => undefined)
      const consoleStatePromise = sdk.client.experimental.console
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => emptyConsoleState)
      const agentsPromise = sdk.client.app.agents({ workspace }, { throwOnError: true })
      const configPromise = sdk.client.config.get({ workspace }, { throwOnError: true })
      await Promise.all([
        providersPromise,
        providerListPromise,
        capabilitiesPromise,
        agentsPromise,
        configPromise,
        projectPromise,
        ...(args.continue ? [sessionListPromise] : []),
      ])
        .then(async () => {
          const providersResponse = providersPromise.then((x) => x.data!)
          const providerListResponse = providerListPromise.then((x) => x.data!)
          const capabilitiesResponse = capabilitiesPromise
          const consoleStateResponse = consoleStatePromise
          const agentsResponse = agentsPromise.then((x) => x.data ?? [])
          const configResponse = configPromise.then((x) => x.data!)
          const sessionListResponse = args.continue ? sessionListPromise : undefined

          return Promise.all([
            providersResponse,
            providerListResponse,
            capabilitiesResponse,
            consoleStateResponse,
            agentsResponse,
            configResponse,
            ...(sessionListResponse ? [sessionListResponse] : []),
          ]).then((responses) => {
            const providers = responses[0]
            const providerList = responses[1]
            const capabilities = responses[2]
            const consoleState = responses[3]
            const agents = responses[4]
            const config = responses[5]
            const sessions = responses[6]

            batch(() => {
              setStore("provider", reconcile(providers.providers))
              setStore("provider_default", reconcile(providers.default))
              setStore("provider_next", reconcile(providerList))
              setStore("capabilities", "experimentalBackgroundSubagents", capabilities?.backgroundSubagents === true)
              setStore("console_state", reconcile(consoleState))
              setStore("agent", reconcile(agents))
              setStore("config", reconcile(config))
              if (sessions !== undefined) applySessionList(sessions)
            })
          })
        })
        .then(() => {
          if (store.status !== "complete") setStore("status", "partial")
          // non-blocking
          void Promise.all([
            ...(args.continue ? [] : [sessionListPromise.then(applySessionList)]),
            consoleStatePromise.then((consoleState) => setStore("console_state", reconcile(consoleState))),
            sdk.client.command.list({ workspace }).then((x) => setStore("command", reconcile(x.data ?? []))),
            sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", reconcile(x.data ?? []))),
            sdk.client.mcp.status({ workspace }).then((x) => setStore("mcp", reconcile(x.data ?? {}))),
            sdk.client.experimental.resource
              .list({ workspace })
              .then((x) => setStore("mcp_resource", reconcile(x.data ?? {}))),
            sdk.client.formatter.status({ workspace }).then((x) => setStore("formatter", reconcile(x.data ?? []))),
            (async () => {
              const touched = new Map(statusMutations)
              statusHydrations.add(touched)
              return await sdk.client.session
                .status({ workspace })
                .then(async (x) => {
                  const statuses = { ...(x.data ?? {}) }
                  for (const sessionID of touched.keys()) {
                    const status = store.session_status[sessionID]
                    if (status) statuses[sessionID] = status
                    if (!status) delete statuses[sessionID]
                  }
                  setStore("session_status", reconcile(statuses))
                  for (const [sessionID, sequence] of touched) {
                    if (statusMutations.get(sessionID) !== sequence) continue
                    if (JSON.stringify(x.data?.[sessionID]) !== JSON.stringify(store.session_status[sessionID]))
                      continue
                    statusMutations.delete(sessionID)
                  }
                  await sessionListPromise
                  const listed = new Set(store.session.map((session) => session.id))
                  await Promise.allSettled(
                    Object.entries(statuses).flatMap(([sessionID, status]) =>
                      status.type === "idle" || !listed.has(sessionID) ? [] : [result.session.sync(sessionID)],
                    ),
                  )
                })
                .finally(() => statusHydrations.delete(touched))
            })(),
            sdk.client.provider.auth({ workspace }).then((x) => setStore("provider_auth", reconcile(x.data ?? {}))),
            sdk.client.vcs.get({ workspace }).then((x) => setStore("vcs", reconcile(x.data))),
            project.workspace.sync(),
          ]).then(() => {
            setStore("status", "complete")
          })
        })
        .catch(async (e) => {
          console.error("tui bootstrap failed", {
            error: e instanceof Error ? e.message : String(e),
            name: e instanceof Error ? e.name : undefined,
            stack: e instanceof Error ? e.stack : undefined,
          })
          if (fatal) {
            exit(e)
          } else {
            throw e
          }
        })
    }

    onMount(() => {
      void bootstrap()
    })

    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        if (startup.skipInitialLoading) return true
        return store.status !== "loading"
      },
      get path() {
        return project.instance.path()
      },
      session: {
        get(sessionID: string) {
          const match = search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        query() {
          return sessionListQuery()
        },
        async refresh() {
          applySessionList(await listSessions())
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        async sync(sessionID: string) {
          if (fullSyncedSessions.has(sessionID)) return
          const syncing = syncingSessions.get(sessionID)
          if (syncing) return syncing
          const tracker = change(sessionID)
          const task = (async () => {
            const [session, messages, todo, diff] = await Promise.all([
              sdk.client.session.get({ sessionID }, { throwOnError: false }),
              sdk.client.session.messages({ sessionID, limit: 100 }),
              sdk.client.session.todo({ sessionID }),
              sdk.client.session.diff({ sessionID }),
            ])
            if (session.response.status === 404) {
              removeSession(sessionID)
              return
            }
            if (!session.data) throw session.error ?? new Error(`Failed to hydrate session ${sessionID}`)
            if (tracker.deleted) return
            setStore(
              produce((draft) => {
                const match = search(draft.session, sessionID, (s) => s.id)
                if (!tracker.session && match.found) draft.session[match.index] = session.data
                if (!tracker.session && !match.found) draft.session.splice(match.index, 0, session.data)
                if (!tracker.todo) draft.todo[sessionID] = todo.data ?? []
                const currentMessages = draft.message[sessionID] ?? []
                const infos = (messages.data ?? []).flatMap((message) => {
                  if (!tracker.messages.has(message.info.id)) return [message.info]
                  const current = currentMessages.find((item) => item.id === message.info.id)
                  return current ? [current] : []
                })
                infos.push(
                  ...currentMessages.filter(
                    (message) => tracker.messages.has(message.id) && !infos.some((item) => item.id === message.id),
                  ),
                )
                infos.sort(compareMessage)
                const removed = infos.slice(0, -100)
                const visible = infos.slice(-100)
                const visibleIDs = new Set(visible.map((message) => message.id))
                for (const message of messages.data ?? []) {
                  if (!visibleIDs.has(message.info.id)) {
                    delete draft.part[message.info.id]
                    continue
                  }
                  const currentParts = draft.part[message.info.id] ?? []
                  const parts = message.parts.flatMap((part) => {
                    const current = currentParts.find((item) => item.id === part.id)
                    if (tracker.parts.has(part.id)) return current ? [current] : []
                    if (
                      current &&
                      (part.type === "text" || part.type === "reasoning") &&
                      (current.type === "text" || current.type === "reasoning") &&
                      part.text.length === 0 &&
                      current.text.length > 0
                    ) {
                      return [current]
                    }
                    return [part]
                  })
                  parts.push(
                    ...currentParts.filter(
                      (part) => tracker.parts.has(part.id) && !parts.some((item) => item.id === part.id),
                    ),
                  )
                  if (parts.length > 0) draft.part[message.info.id] = parts
                  if (parts.length === 0) delete draft.part[message.info.id]
                }
                for (const message of removed) delete draft.part[message.id]
                draft.message[sessionID] = visible
                if (!tracker.diff) draft.session_diff[sessionID] = diff.data ?? []
              }),
            )
            fullSyncedSessions.add(sessionID)
          })().finally(() => {
            syncingSessions.delete(sessionID)
            if (fullSyncedSessions.has(sessionID) || tracker.deleted) sessionChanges.delete(sessionID)
          })
          syncingSessions.set(sessionID, task)
          return task
        },
      },
      bootstrap,
    }
    return result
  },
})
