import type { Agent } from "@opencode/schema/agent"
import type { Location } from "@opencode/schema/location"
import type { Project } from "@opencode/schema/project"
import type { Session } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"

/** An exact, single-message handoff binding. Experimental; no reusable authority is created. */
export interface HandoffInput {
  readonly sender: {
    readonly sessionID: Session.ID
    readonly agent: Agent.ID
    readonly messageID: SessionMessage.ID
    readonly callID: string
  }
  readonly target: {
    readonly sessionID: Session.ID
    readonly projectID: Project.ID
    readonly location: Location.Ref
    readonly agent?: Agent.ID
  }
  readonly text: string
  /** False inspects an existing receipt without admitting new input. True requires the plugin's explicit user approval. */
  readonly commit: boolean
}

/** Delivery means promotion into Session history, not a model acknowledgement or completed repair. */
export interface HandoffReceipt {
  readonly id: SessionMessage.ID
  readonly sessionID: Session.ID
  readonly status: "approval-required" | "admitted" | "delivered"
  readonly duplicate: boolean
  readonly wakeScheduled: boolean
}
