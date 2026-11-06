import type { ExperimentalSessionApi, SessionApi } from "@opencode/client/promise/api"
import type { GenerationOptionsFields, Message, SystemPart } from "@opencode/ai/effect"
import type { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"
import type { PromptInput } from "@opencode/schema/prompt-input"
import type { Session } from "@opencode/schema/session"
import type { SessionInbox } from "@opencode/schema/session-inbox"
import type { SessionError } from "@opencode/schema/session-error"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { TokenUsage } from "@opencode/schema/token-usage"
import type { JsonSchema, Types } from "effect"
import type { Registration } from "./registration.js"
import type { ContinueAfterIdleInput, ContinueAfterIdleOutcome, ContinueAfterFailureInput, ContinueAfterFailureOutcome, PluginInterruptResult, SessionHookOptions } from "../effect/session.js"

export interface SessionPrompt {
  readonly sessionID: Session.ID
  readonly messageID: SessionMessage.ID
  prompt: Types.DeepMutable<PromptInput.Prompt>
  metadata?: Record<string, unknown>
  delivery: SessionInbox.Delivery
}

/** Request overrides. Typed keys are generation settings; any other key is a provider option. */
export type SessionRequestOptions = Types.DeepMutable<GenerationOptionsFields> & Record<string, unknown>

export interface SessionRequest {
  readonly sessionID: Session.ID
  readonly model: Model.Ref
  /**
   * The instructions part keeps each source's text in `metadata.experimental.instructions` as `{ key, text }`. It is
   * not updated when a hook edits `text`. Experimental.
   */
  system: Array<SystemPart>
  messages: Array<Message>
  options: SessionRequestOptions
}

export interface SessionContext extends SessionRequest {
  readonly agent: Agent.ID
  tools: Record<string, { description: string; input: JsonSchema.JsonSchema }>
}

export interface SessionCompactionResult {
  summary: string
  /** `native.messages`, when set, must be a provider replacement window; it replays instead of `summary`. */
  native?: SessionMessage.Native
  metadata?: Record<string, unknown>
  tokens?: TokenUsage.Info
}

export interface SessionCompaction extends SessionContext {
  /** Set to use this compaction and skip the model request. */
  result?: SessionCompactionResult
}

export interface SessionGenerate extends SessionContext {}

export interface SessionTitle extends SessionRequest {
  /** Set to use this title and skip the model request. */
  result?: string
}

/**
 * Why a Session request is being made. Auxiliary requests share the Session's
 * hook identity but need to be told apart from the agent loop.
 */
export type SessionRequestKind = "primary" | "compaction" | "title" | "generate"

export interface SessionModelRequest {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  /** Non-secret identity of the connection selected at model resolution; undefined when unknown. */
  readonly connectionKey?: string
  baseURL?: string
  headers: Record<string, string>
}

export interface SessionHttpRequest {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  /** Non-secret identity of the connection selected at model resolution; undefined when unknown. */
  readonly connectionKey?: string
  request: Request
}

export interface SessionHttpResponse {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  /** Non-secret identity of the connection selected at model resolution; undefined when unknown. */
  readonly connectionKey?: string
  readonly request: Request
  response: Response
}

/**
 * Connection a WebSocket-backed request opens or reuses. Runs once per model call before the
 * Session's socket is selected; changing `url` or `headers` reopens the socket. Experimental.
 */
export interface SessionWebSocketHandshake {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  url: string
  headers: Record<string, string>
}

/**
 * Outbound frame about to be written to the Session's socket, after the provider driver has built
 * it. Replacing `frame` sends the replacement verbatim; the driver still tracks state from the
 * provider's replies, so a rewrite that changes protocol meaning is on the plugin. Experimental.
 */
export interface SessionWebSocketSend {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  frame: string
}

/**
 * Inbound frame read from the Session's socket, before the provider driver observes it. Replacing
 * `frame` hands the replacement to the driver verbatim. Experimental.
 */
export interface SessionWebSocketReceive {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly kind: SessionRequestKind
  frame: string
}

export type SessionRetryDecision = { retry: false } | { retry: true; delay: number }

export interface SessionRetry {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly error: SessionError.Error
  readonly attempt: number
  decision: SessionRetryDecision
}

/**
 * Background work still running for the idle Session or one of its descendants. `sessionID` is
 * the Session that owns the job: the idle Session itself, or a descendant such as a subagent child.
 */
export type SessionIdleBackground =
  | {
      readonly kind: "shell"
      readonly sessionID: Session.ID
      readonly shellID: string
      readonly command: string
    }
  | {
      readonly kind: "subagent"
      readonly wakes?: boolean
      readonly sessionID: Session.ID
      readonly childSessionID: Session.ID
      readonly agent: string
      readonly description: string
    }
  | {
      readonly kind: "image"
      readonly sessionID: Session.ID
      readonly path: string
      readonly model: string
    }

/**
 * Runs when a Session finishes model work and has no pending input, just before it goes idle.
 * It does not run after interruption, failure, or control-only work such as a manual compaction.
 * Input admitted by the hook, such as a synthetic message, runs in the same execution instead
 * of the Session going idle.
 *
 * `background` lists work that is still running. When the Session's own shell or subagent finishes,
 * its notice wakes the Session and the hook runs again, so a plugin that waits for that work can
 * simply return. Work a descendant owns, such as a shell a subagent left running, wakes that
 * descendant instead, so it is listed for information only. Notices admitted with `resume: false`,
 * such as those recovered after a restart, wait for the next wake. Experimental.
 */
export interface SessionIdle {
  readonly sessionID: Session.ID
  readonly background: ReadonlyArray<SessionIdleBackground>
  readonly admit: (input: { readonly id: SessionMessage.ID; readonly text: string; readonly description?: string }) => Promise<"admitted" | "duplicate" | "stale">
}

export interface SessionCompactionContinue {
  readonly sessionID: Session.ID
  readonly compactionID: SessionMessage.ID
  readonly reason: "auto" | "overflow"
  readonly agent: Agent.ID
  readonly model: Model.Ref
  enabled: boolean
}

export interface SessionHooks {
  readonly prompt: SessionPrompt
  readonly context: SessionContext
  readonly compaction: SessionCompaction
  readonly generate: SessionGenerate
  readonly title: SessionTitle
  readonly "model.request": SessionModelRequest
  readonly "http.request": SessionHttpRequest
  readonly "http.response": SessionHttpResponse
  readonly "experimental.ws.handshake": SessionWebSocketHandshake
  readonly "experimental.ws.send": SessionWebSocketSend
  readonly "experimental.ws.receive": SessionWebSocketReceive
  readonly retry: SessionRetry
  readonly "experimental.idle": SessionIdle
  readonly "experimental.compaction.continue": SessionCompactionContinue
}

export type SessionDomain = Pick<
  SessionApi,
  | "list"
  | "create"
  | "get"
  | "remove"
  | "switchAgent"
  | "switchModel"
  | "prompt"
  | "generate"
  | "command"
  | "compact"
  | "synthetic"
  | "interrupt"
  | "update"
  | "move"
  | "context"
> &
  Pick<ExperimentalSessionApi, "wait" | "instructions"> & {
    readonly hook: <Name extends keyof SessionHooks>(name: Name, callback: (event: SessionHooks[Name]) => void | Promise<void>, options?: SessionHookOptions<Name>) => Promise<Registration>
  }

export type { ContinueAfterIdleInput, ContinueAfterIdleOutcome, ContinueAfterFailureInput, ContinueAfterFailureOutcome, PluginInterruptResult } from "../effect/session.js"

/** Native continuation after a failed idle boundary. Experimental. */
export interface ExperimentalSessionDomain {
  /** Admits at the newest succeeded idle with no pending input, waking child or staged revert. Experimental. */
  readonly continueAfterIdle: (input: ContinueAfterIdleInput) => Promise<ContinueAfterIdleOutcome>
  readonly recover: (input: { readonly sessionID: Session.ID }, callback: (input: { readonly boundaryID: SessionMessage.ID }) => Promise<boolean>, options?: { readonly signal?: AbortSignal }) => Promise<boolean>
  /** Session execution snapshot for trusted plugin processes; absent means inherit the host environment. Experimental. */
  readonly environment: (input: { readonly sessionID: Session.ID }) => Promise<Readonly<Record<string, string>> | undefined>
  /** Admits the model change and steered continuation only while `boundaryID` is still the newest entry, then wakes once. */
  readonly continueAfterFailure: (input: ContinueAfterFailureInput) => Promise<ContinueAfterFailureOutcome>
  /** Interrupts without retaining recovery ownership. Use `recover` for a recoverable stop. */
  readonly interrupt: (input: { readonly sessionID: Session.ID }) => Promise<PluginInterruptResult>
}
