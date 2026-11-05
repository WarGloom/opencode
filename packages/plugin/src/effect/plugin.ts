import type { CredentialApi, ExperimentalApi, ExperimentalGenerateApi, PluginApi } from "@opencode/client/effect/api"
import type { Location } from "@opencode/schema/location"
import type { Effect, Scope } from "effect"
import type { PluginOptions } from "../options.js"
import type { App } from "../app.js"
import type { AgentDomain } from "./agent.js"
import type { ExperimentalArtifactDomain } from "./artifact.js"
import type { AISDKDomain } from "./aisdk.js"
import type { CommandDomain } from "./command.js"
import type { EventDomain } from "./event.js"
import type { IntegrationDomain } from "./integration.js"
import type { MCPDomain } from "./mcp.js"
import type { ExperimentalModelDomain, ExperimentalVariantDomain, ModelDomain } from "./model.js"
import type { Session } from "@opencode/schema/session"
import type { PermissionDomain } from "./permission.js"
import type { ProviderDomain } from "./provider.js"
import type { ReferenceDomain } from "./reference.js"
import type { RpcDomain } from "./rpc.js"
import type { ExperimentalSessionDomain, SessionDomain } from "./session.js"
import type { ShellDomain } from "./shell.js"
import type { ExperimentalSkillDomain, SkillDomain } from "./skill.js"
import type { StorageDomain } from "./storage.js"
import type { ToolDomain } from "./tool.js"
import type { VcsDomain } from "./vcs.js"
import type { WebSearchDomain } from "./websearch.js"
import type { WorktreeDomain } from "./worktree.js"
import type { SubagentDomain } from "./subagent.js"

export interface Context {
  readonly app: App
  readonly location: Location.Info
  readonly options: PluginOptions
  readonly agent: AgentDomain
  readonly aisdk: AISDKDomain
  readonly command: CommandDomain
  readonly credential: Pick<CredentialApi<unknown>, "activate">
  readonly event: EventDomain
  readonly experimental: {
    readonly skill: ExperimentalSkillDomain
    readonly formatter: { readonly file: (input: { readonly sessionID: Session.ID; readonly filepath: string }) => Effect.Effect<boolean, unknown> }
    readonly variant: ExperimentalVariantDomain
    readonly model: ExperimentalModelDomain
    readonly subagent: SubagentDomain
    readonly session: ExperimentalSessionDomain
    readonly terminal: Pick<ExperimentalApi<unknown>["persistentPty"], "read">
    /** Stateless generation with a model and a prompt: no session, history or tools. */
    readonly generate: ExperimentalGenerateApi<unknown>
    readonly artifact: ExperimentalArtifactDomain
  }
  readonly integration: IntegrationDomain
  readonly mcp: MCPDomain
  readonly model: ModelDomain
  /** @deprecated Use `experimental.generate.text`. */
  readonly generate: Pick<ExperimentalGenerateApi<unknown>, "text">
  readonly permission: PermissionDomain
  readonly plugin: Pick<PluginApi<unknown>, "list">
  readonly provider: ProviderDomain
  readonly reference: ReferenceDomain
  readonly rpc: RpcDomain
  readonly session: SessionDomain
  readonly shell: ShellDomain
  readonly skill: SkillDomain
  readonly storage: StorageDomain
  readonly tool: ToolDomain
  readonly vcs: VcsDomain
  readonly websearch: WebSearchDomain
  readonly worktree: WorktreeDomain
}

export interface Plugin<R = Scope.Scope> {
  readonly id: string
  readonly effect: (context: Context) => Effect.Effect<void, never, R>
}

export function define<R = Scope.Scope>(plugin: Plugin<R>) {
  return plugin
}
