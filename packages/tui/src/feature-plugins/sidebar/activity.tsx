import { Plugin } from "@opencode/plugin/tui"
import { createMemo, For, Show } from "solid-js"

const TASK_TOOLS = new Set(["subagent", "task"])
const COMMAND_TOOLS = new Set(["shell", "bash", "interactive_bash"])

function plural(count: number, word: string) {
  return count ? `${count} ${word}${count === 1 ? "" : "s"}` : ""
}

export function SidebarActivity(props: { context: Plugin.Context }) {
  const [view, updateView] = props.context.storage.store("view", { initial: { open: true } })
  const theme = props.context.theme
  const data = props.context.data
  const activity = createMemo(() => {
    const sessions = data.session
      .list()
      .filter((session) => session.time.archived === undefined && data.session.status(session.id) === "running")
    const running = sessions.flatMap((session) =>
      data.session.message
        .list(session.id)
        .flatMap((message) =>
          message.type === "assistant"
            ? message.content.filter((part) => part.type === "tool" && part.state.status === "running")
            : [],
        ),
    )
    const subagents = sessions.filter((session) => session.parentID).length
    return {
      sessions,
      summary: [
        plural(sessions.length - subagents, "agent"),
        subagents ? `${subagents} sub` : "",
        plural(running.filter((part) => part.type === "tool" && TASK_TOOLS.has(part.name)).length, "task"),
        plural(running.filter((part) => part.type === "tool" && COMMAND_TOOLS.has(part.name)).length, "cmd"),
      ]
        .filter(Boolean)
        .join(" · "),
    }
  })

  return (
    <Show when={activity().sessions.length > 0}>
      <box>
        <box
          flexDirection="row"
          gap={1}
          onMouseDown={() => {
            void updateView((draft) => {
              draft.open = !draft.open
            }).catch((error) => console.error("Failed to persist activity sidebar state", error))
          }}
        >
          <text fg={theme.text.base}>{view.open ? "▼" : "▶"}</text>
          <text fg={theme.text.base}>
            <b>Activity</b>
            <Show when={activity().summary}>
              <span style={{ fg: theme.text.muted }}> ({activity().summary})</span>
            </Show>
          </text>
        </box>
        <Show when={view.open}>
          <For each={activity().sessions}>
            {(session) => {
              const title = session.title ?? session.id
              const split = title.indexOf(": ")
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    props.context.ui.router.navigate({ type: "session", sessionID: session.id })
                  }}
                >
                  <text flexShrink={0} fg={theme.text.feedback.success.base}>
                    •
                  </text>
                  <box flexDirection="column" flexGrow={1} flexShrink={1}>
                    <Show
                      when={split >= 0}
                      fallback={
                        <text fg={theme.text.base} wrapMode="none" truncate>
                          {title}
                        </text>
                      }
                    >
                      <box flexDirection="row" flexGrow={1} flexShrink={1}>
                        <text flexShrink={0} fg={theme.text.base} wrapMode="none">
                          {title.slice(0, split + 2)}
                        </text>
                        <text flexGrow={1} flexShrink={1} fg={theme.text.base} wrapMode="none" truncate>
                          {title.slice(split + 2)}
                        </text>
                      </box>
                    </Show>
                    <text fg={theme.text.muted} wrapMode="none" truncate>
                      {session.agent ?? (session.parentID ? "Subagent" : "Agent")} · Running
                    </text>
                  </box>
                </box>
              )
            }}
          </For>
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
      render: () => <SidebarActivity context={context} />,
    })
  },
})
