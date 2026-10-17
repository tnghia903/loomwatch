import type { AgentAllow, AgentLink, CapabilityRef } from '../team-file/types'

export type LibraryGroup = 'agents' | 'presets'

/**
 * A drag source row in the Library (docs/CANVAS_SPEC.md §4). This is the payload placed on
 * `dataTransfer` under `application/loomwatch-source` (§4.5 step 1) and read back on drop to
 * build the new agent's defaults (§4.5 step 4) — it must stay JSON-serializable.
 */
export interface LibrarySource {
  group: LibraryGroup
  kind?: 'operator'
  /** Stable id within its group; not the future agent id (that is slugified from `label`). */
  id: string
  /** Becomes the new agent's `name`. */
  label: string
  /** Only presets pre-fill the role — §4.5: "From a preset, both are already filled". */
  role?: string
  /** The OpenRouter model it runs on; absent is the default model. */
  model?: string
  /** How hard that model thinks; it goes with the model. */
  thinkingEffort?: string
  /** What the finished result must satisfy (ADR 0062); a job brings its own. */
  doneWhen?: string[]
  /** Skills a job brings with it (ADR 0030/0031). */
  capabilities?: CapabilityRef[]
  /** What the agent it places may do without asking (ADR 0037). */
  allow?: AgentAllow
  /** One of Your agents: the placed agent links back to this version of it. */
  from?: AgentLink
}
