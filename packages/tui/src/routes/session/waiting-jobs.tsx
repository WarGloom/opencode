import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import type { JobInfo } from "@opencode/client"
import { useData } from "../../context/data"
import { useTheme } from "../../context/theme"
import { Locale } from "../../util/locale"

export function waitingJobs(jobs: JobInfo[], sessionID: string) {
  return jobs.filter((job) => job.sessionID === sessionID && (job.kind === "shell" || job.kind === "codemode"))
}

export function waitingSummary(jobs: JobInfo[], now: number) {
  const shell = jobs.filter((job) => job.kind === "shell").length
  const script = jobs.length - shell
  const kinds = [shell && `${shell} shell${shell === 1 ? "" : "s"}`, script && `${script} script${script === 1 ? "" : "s"}`]
    .filter(Boolean)
    .join(", ")
  const ms = Math.max(0, now - Math.min(...jobs.map((job) => job.time.started)))
  const elapsed = ms < 60_000 ? `${Math.floor(ms / 1000)}s` : Locale.duration(ms)
  return `${kinds} · ${elapsed}`
}

export function WaitingJobs(props: { sessionID: string }) {
  const data = useData()
  const theme = useTheme()
  const [now, setNow] = createSignal(Date.now())
  const jobs = createMemo(() => waitingJobs(data.job.list(data.session.root(props.sessionID)), props.sessionID))
  const visible = () => data.session.status(props.sessionID) === "idle" && jobs().length > 0

  createEffect(() => {
    if (!visible()) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <Show when={visible()}>
      <box paddingLeft={3}>
        <text fg={theme.text.muted} wrapMode="none">
          ◷ Waiting for {waitingSummary(jobs(), now())} · resumes when a job finishes
        </text>
      </box>
    </Show>
  )
}
