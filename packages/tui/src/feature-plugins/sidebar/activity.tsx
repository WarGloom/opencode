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
          onMouseDown={() => activity().sessions.length > 2 && setOpen((value) => !value)}
        >
          <Show when={activity().sessions.length > 2}>
            <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme().text}>
            <b>Activity</b>
            <Show when={summary()}>
              <span style={{ fg: theme().textMuted }}> ({summary()})</span>
            </Show>
          </text>
        </box>
        <Show when={activity().sessions.length <= 2 || open()}>
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
                <text fg={theme().text} wrapMode="word">
                  {session.agent ?? (session.parentID ? "Subagent" : "Agent")}{" "}
                  <span style={{ fg: theme().textMuted }}>
                    {session.title} · {session.status === "retry" ? "Retrying" : "Running"}
                  </span>
                </text>
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
