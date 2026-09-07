import { createContext, useContext } from 'react'

/**
 * The two inline-editable node fields (docs/CANVAS_SPEC.md §5.4: name and role, double-click
 * to edit in place). Provided via context rather than threaded through node `data` so node
 * data stays a plain, JSON-serializable snapshot of the agent.
 */
export interface CanvasActions {
  renameAgent: (id: string, field: 'name' | 'role', value: string) => void
}

export const CanvasActionsContext = createContext<CanvasActions | null>(null)

export function useCanvasActions(): CanvasActions {
  const actions = useContext(CanvasActionsContext)
  if (!actions) {
    throw new Error('useCanvasActions must be used within a CanvasActionsContext.Provider')
  }
  return actions
}
