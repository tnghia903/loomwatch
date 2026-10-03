import { createContext, useContext } from 'react'

import type { PipelineStep } from '../../lib/team-file/pipelineOrder'
import type { ExecutionMode } from '../../lib/team-file/useTeamDocument'

/**
 * The two inline-editable node fields (docs/CANVAS_SPEC.md §5.4: name and role, double-click
 * to edit in place), plus the execution-mode framing every node needs (§8.2: dormant vs active
 * handles, pipeline step badges). Provided via context rather than threaded through node `data`
 * so node data stays a plain, JSON-serializable snapshot of the agent.
 */
export interface CanvasActions {
  editable?: boolean
  renameAgent: (id: string, field: 'name' | 'role', value: string) => void
  touchField: (id: string, field: 'name' | 'role') => void
  mode: ExecutionMode
  stepById: ReadonlyMap<string, PipelineStep>
  nodeNames: ReadonlyMap<string, string>
  /** TNG-113: an evidence card opens the activity panel; the output node toggles provenance. */
  inspectEvidence?: (id: string | null) => void
  toggleProvenance?: () => void
  /** §3.4: `[ Reuse ]` on a failed response node copies the run's prompt back into the composer. */
  reusePrompt?: () => void
  /** Opens what an agent was given: the handover it received and the memory packet it was supplied. */
  inspectHandover?: (agentId: string | null) => void
  /**
   * §15.2.2: the permanent Prompt node is the composer seen in a second place, so clicking it
   * focuses the one editor rather than opening another.
   */
  focusComposer?: () => void
  /** §15.2.3: fans one agent's evidence beside it, folding whichever agent was fanned before. */
  toggleEvidenceFan?: (agentId: string) => void
  /** Brief entries this team supplies, so a card only claims "reads the brief" when there is one. */
  briefCount?: number
  /** The team-level `memory.deliverAs`, which a per-agent override may narrow. */
  teamDeliverAs?: 'native-file' | 'packet-only'
  /**
   * Whether this team's agents get the four memory tools, so a card only claims "writes notes"
   * when there is a notebook to write to.
   *
   * Configuration, not runtime: the chip says what the agent *may* do, the way "reads the brief"
   * does. What it actually wrote is in the evidence count beside it.
   */
  notebookEnabled?: boolean
  /** The agent a skill, tool, folder or file is being dragged over: dropping connects it there. */
  dropTargetId?: string | null
}

export const CanvasActionsContext = createContext<CanvasActions | null>(null)

export function useCanvasActions(): CanvasActions {
  const actions = useContext(CanvasActionsContext)
  if (!actions) {
    throw new Error('useCanvasActions must be used within a CanvasActionsContext.Provider')
  }
  return actions
}
