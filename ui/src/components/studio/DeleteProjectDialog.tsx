import { useId, useState } from 'react'

import { listNames } from '../../lib/format'
import { deleteProject } from '../../lib/projects/client'

export interface DeleteProjectDialogProps {
  project: { id: string; name: string }
  /** Its teams' names: they stay, in no project (ADR 0100). */
  teams: readonly string[]
  onDeleted: () => void
  onClose: () => void
}

/** The one confirmation for deleting a project, from Home and from the project alike. */
export function DeleteProjectDialog({ project, teams, onDeleted, onClose }: DeleteProjectDialogProps) {
  const titleId = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await deleteProject(project.id)
      onDeleted()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setBusy(false)
    }
  }

  return (
    <div className="lw-scrim dim" onMouseDown={() => { if (!busy) onClose() }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} className="pop e2 lw-deleteteam" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose() } }}>
        <h2 id={titleId}>Delete the project “{project.name}”?</h2>
        {teams.length === 1 && <p>Its team, {teams[0]}, stays on Home, under Not in a project.</p>}
        {teams.length > 1 && <p>Its teams stay on Home, under Not in a project: {listNames(teams)}.</p>}
        <p title=".projects/.removed, inside your teams folder">Its About and notes go with it. Nothing is erased: LoomWatch keeps them in your teams folder, and your own folders stay where they are.</p>
        {error && <p role="alert" className="dt-alert">{error}</p>}
        <div className="dt-acts">
          <button type="button" className="btn" autoFocus onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-danger-fill" onClick={() => void confirm()} disabled={busy}>{busy ? 'Deleting…' : 'Delete project'}</button>
        </div>
      </div>
    </div>
  )
}
