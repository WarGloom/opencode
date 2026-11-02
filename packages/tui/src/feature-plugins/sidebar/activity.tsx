import { Plugin } from "@opencode/plugin/tui"
import { createMemo, For, Show } from "solid-js"

type Session = ReturnType<Plugin.Context["data"]["session"]["list"]>[number]

const TASK_TOOLS = new Set(["subagent", "task"])
const COMMAND_TOOLS = new Set(["shell", "bash", "interactive_bash"])

function plural(count: number, word: string) {
  return count ? `${count} ${word}${count === 1 ? "" : "s"}` : ""
}

function summarize(context: Plugin.Context, sessions: Session[]) {
  const running = sessions.flatMap((session) =>
    context.data.session.message
      .list(session.id)
      .flatMap((message) =>
        message.type === "assistant"
          ? message.content.filter((part) => part.type === "tool" && part.state.status === "running")
          : [],
      ),
  )
  const subagents = sessions.filter((session) => session.parentID).length
  return [
    plural(sessions.length - subagents, "agent"),
    subagents ? `${subagents} sub` : "",
    plural(running.filter((part) => part.type === "tool" && TASK_TOOLS.has(part.name)).length, "task"),
    plural(running.filter((part) => part.type === "tool" && COMMAND_TOOLS.has(part.name)).length, "cmd"),
  ]
    .filter(Boolean)
    .join(" · ")
}

function ActivityRow(props: { context: Plugin.Context; session: Session }) {
  const theme = props.context.theme
  const title = () => props.session.title ?? props.session.id
  const split = () => title().indexOf(": ")
  return (
    <box
      flexDirection="row"
      gap={1}
      onMouseDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
        props.context.ui.router.navigate({ type: "session", sessionID: props.session.id })
      }}
    >
      <text flexShrink={0} fg={theme.text.feedback.success.base}>
        •
      </text>
      <box flexDirection="column" flexGrow={1} flexShrink={1}>
        <Show
          when={split() >= 0}
          fallback={
            <text fg={theme.text.base} wrapMode="none" truncate>
              {title()}
            </text>
          }
        >
          <box flexDirection="row" flexGrow={1} flexShrink={1}>
            <text flexShrink={0} fg={theme.text.base} wrapMode="none">
              {title().slice(0, split() + 2)}
            </text>
            <text flexGrow={1} flexShrink={1} fg={theme.text.base} wrapMode="none" truncate>
              {title().slice(split() + 2)}
            </text>
          </box>
        </Show>
        <text fg={theme.text.muted} wrapMode="none" truncate>
          {props.session.agent ?? (props.session.parentID ? "Subagent" : "Agent")} · Running
        </text>
      </box>
    </box>
  )
}

/** Running sessions of the shown session's family first; the rest of its project behind a toggle. */
export function SidebarActivity(props: { context: Plugin.Context; sessionID: string }) {
  const [view, updateView] = props.context.storage.store("view", { initial: { open: true, workspace: false } })
  const theme = props.context.theme
  const data = props.context.data
  const toggle = (key: "open" | "workspace") =>
    void updateView((draft) => {
      draft[key] = !draft[key]
    }).catch((error) => console.error("Failed to persist activity sidebar state", error))
  const activity = createMemo(() => {
    const family = new Set([data.session.root(props.sessionID), ...data.session.family(props.sessionID)])
    const projectID = data.session.get(props.sessionID)?.projectID
    const running = data.session
      .list()
      .filter((session) => session.time.archived === undefined && data.session.status(session.id) === "running")
    const session = running.filter((item) => family.has(item.id))
    const workspace = running.filter((item) => !family.has(item.id) && item.projectID === projectID)
    return {
      session,
      workspace,
      summary: summarize(props.context, session),
      workspaceSummary: summarize(props.context, workspace),
    }
  })

  return (
    <Show when={activity().session.length > 0 || activity().workspace.length > 0}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => toggle("open")}>
          <text fg={theme.text.base}>{view.open ? "▼" : "▶"}</text>
          <text fg={theme.text.base}>
            <b>Activity</b>
            <Show when={activity().summary}>
              <span style={{ fg: theme.text.muted }}> ({activity().summary})</span>
            </Show>
          </text>
        </box>
        <Show when={view.open}>
          <For each={activity().session}>{(session) => <ActivityRow context={props.context} session={session} />}</For>
          <Show when={activity().workspace.length > 0}>
            <box flexDirection="row" gap={1} onMouseDown={() => toggle("workspace")}>
              <text fg={theme.text.muted}>{view.workspace ? "▼" : "▶"}</text>
              <text fg={theme.text.muted}>Workspace ({activity().workspaceSummary})</text>
            </box>
            <Show when={view.workspace}>
              <For each={activity().workspace}>
                {(session) => <ActivityRow context={props.context} session={session} />}
              </For>
            </Show>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode.sidebar.activity",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarActivity context={context} sessionID={props.sessionID} />,
    })
  },
})
