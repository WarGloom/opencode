import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createSignal, For, Show } from "solid-js"

const id = "internal:sidebar-activity"

type ActivityApi = {
  readonly state: Pick<TuiPluginApi["state"], "activity">
  readonly theme: {
    readonly current: Pick<TuiPluginApi["theme"]["current"], "text" | "textMuted" | "success" | "warning">
  }
  readonly route: Pick<TuiPluginApi["route"], "navigate">
}

export function Activity(props: { api: ActivityApi }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const activity = createMemo(() => props.api.state.activity())
  const summary = createMemo(() => {
    const value = activity()
    return [
      value.agents ? `${value.agents} agent${value.agents === 1 ? "" : "s"}` : "",
      value.subagents ? `${value.subagents} sub` : "",
      value.tasks ? `${value.tasks} task${value.tasks === 1 ? "" : "s"}` : "",
      value.commands ? `${value.commands} cmd${value.commands === 1 ? "" : "s"}` : "",
    ]
      .filter(Boolean)
      .join(" · ")
  })

  return (
    <Show when={activity().sessions.length > 0}>
      <box>
        <box
          flexDirection="row"
          gap={1}
          onMouseDown={() => setOpen((value) => !value)}
        >
          <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          <text fg={theme().text}>
            <b>Activity</b>
            <Show when={summary()}>
              <span style={{ fg: theme().textMuted }}> ({summary()})</span>
            </Show>
          </text>
        </box>
        <Show when={open()}>
          <For each={activity().sessions}>
            {(session) => (
              <box
                flexDirection="row"
                gap={1}
                onMouseDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  props.api.route.navigate("session", { sessionID: session.id })
                }}
              >
                <text flexShrink={0} fg={session.status === "retry" ? theme().warning : theme().success}>
                  •
                </text>
                <box flexDirection="column" flexGrow={1} flexShrink={1}>
                  <Show
                    when={session.title.includes(": ")}
                    fallback={
                      <text fg={theme().text} wrapMode="none" truncate>
                        {session.title}
                      </text>
                    }
                  >
                    <box flexDirection="row" flexGrow={1} flexShrink={1}>
                      <text flexShrink={0} fg={theme().text} wrapMode="none">
                        {session.title.slice(0, session.title.indexOf(": ") + 2)}
                      </text>
                      <text flexGrow={1} flexShrink={1} fg={theme().text} wrapMode="none" truncate>
                        {session.title.slice(session.title.indexOf(": ") + 2)}
                      </text>
                    </box>
                  </Show>
                  <text fg={theme().textMuted} wrapMode="none" truncate>
                    {session.agent ?? (session.parentID ? "Subagent" : "Agent")} · {session.status === "retry" ? "Retrying" : "Running"}
                  </text>
                </box>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 150,
    slots: {
      sidebar_content() {
        return <Activity api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
