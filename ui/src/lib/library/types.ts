import type { HarnessSpawn } from '../harnesses'
import type { AgentAllow, CapabilityRef } from '../team-file/types'

export type LibraryGroup = 'detected' | 'endpoints' | 'presets'

/**
 * A drag source row in the Library (docs/CANVAS_SPEC.md §4). This is the payload placed on
 * `dataTransfer` under `application/loomwatch-source` (§4.5 step 1) and read back on drop to
 * build the new agent's defaults (§4.5 step 4) — it must stay JSON-serializable.
 */
export interface LibrarySource {
  group: LibraryGroup
  kind?: 'operator'
  unavailableReason?: string
  /** Stable id within its group; not the future agent id (that is slugified from `label`). */
  id: string
  /** Becomes the new agent's `name`. */
  label: string
  /** Copied verbatim into the new agent's `spawn` (cmd, args), plus `env: {}`, `cwd: "."`. */
  spawn: HarnessSpawn
  /** Only presets pre-fill these — §4.5: "From a preset, both are already filled". */
  role?: string
  model?: string
  /** Skills a job brings with it (ADR 0030/0031); delivered on whatever app the agent runs. */
  capabilities?: CapabilityRef[]
  /** What the agent it places may do without asking (ADR 0037). */
  allow?: AgentAllow
}
