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
  renameAgent: (id: string, field: 'name' | 'role', value: string) => void
  mode: ExecutionMode
  stepById: ReadonlyMap<string, PipelineStep>
  nodeNames: ReadonlyMap<string, string>
}

export const CanvasActionsContext = createContext<CanvasActions | null>(null)

export function useCanvasActions(): CanvasActions {
  const actions = useContext(CanvasActionsContext)
  if (!actions) {
    throw new Error('useCanvasActions must be used within a CanvasActionsContext.Provider')
  }
  return actions
}
