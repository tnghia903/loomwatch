import { useCallback, useEffect, useId, useState } from 'react'

import { fetchRuns, isTerminalRun } from '../../lib/runs/client'
import { deleteTeamFile, fetchTeamsDiscovery, teamPathUnderRoot, type DeletedTeam } from '../../lib/team-file/client'

export interface DeleteTeamDialogProps {
  /** The team file as the team list (relative) or the open document (absolute) names it. */
  path: string
  /** What the operator calls the team. */
  name: string
  onDeleted: (deleted: DeletedTeam) => void
  onClose: () => void
}

/** How often an open dialog asks again whether the team's run has finished. */
const LIVE_RECHECK_MS = 4000

/**
 * The one confirmation for deleting a team, from Home and from the team switcher alike.
 *
 * It says what happens in the operator's words: the team leaves the list, nothing is erased, and
 * moving the files back brings it back with its history. A team with an unfinished run cannot be
 * deleted; the daemon refuses that itself (ADR 0028), and asking it for the runs first means the
 * operator is told before choosing, not after.
 */
export function DeleteTeamDialog({ path, name, onDeleted, onClose }: DeleteTeamDialogProps) {
  const titleId = useId()
  const [live, setLive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Runs are filed under the path relative to the teams folder. Home names a team that way; the
  // open document names it absolutely, and the discovery root converts one into the other exactly,
  // where matching on the end of the path would mistake `a/trip.yaml` for `trip.yaml`. When the
  // root cannot be had, nothing matches and the daemon's own check is the only one: this can
  // under-report, but never block a team that is not running.
  const check = useCallback((signal: AbortSignal) => Promise.all([
    fetchRuns(signal),
    path.startsWith('/') ? fetchTeamsDiscovery().then((discovery) => teamPathUnderRoot(discovery.root, path)) : path,
  ])
    .then(([runs, teamPath]) => { if (!signal.aborted) setLive(runs.some((run) => run.teamPath === teamPath && !isTerminalRun(run.status))) })
    .catch(() => { /* No run control (no database): nothing can be running. */ }), [path])

  useEffect(() => {
    const controller = new AbortController()
    void check(controller.signal)
    return () => controller.abort()
  }, [check])

  // While it is running, keep asking, so the dialog unlocks the moment the run ends.
  useEffect(() => {
    if (!live) return
    const controller = new AbortController()
    const timer = window.setInterval(() => void check(controller.signal), LIVE_RECHECK_MS)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [live, check])

  async function confirm() {
    if (busy || live) return
    setBusy(true)
    setError(null)
    try {
      onDeleted(await deleteTeamFile(path))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setBusy(false)
    }
  }

  return (
    <div className="lw-scrim dim" onMouseDown={() => { if (!busy) onClose() }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} className="pop e2 lw-deleteteam" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose() } }}>
        <h2 id={titleId}>Delete “{name}”?</h2>
        <p>It leaves your teams list. Nothing is erased: its file, layout, notes and any files you added to its agents move to a hidden <code>.trash</code> folder inside your teams folder, and moving them back restores the team.</p>
        <p>LoomWatch keeps its past runs, so they come back if you restore it.</p>
        {live && <p role="alert" className="dt-alert">“{name}” is running right now. Stop the run or wait for it to finish, then delete the team.</p>}
        {error && <p role="alert" className="dt-alert">{error}</p>}
        <div className="dt-acts">
          <button type="button" className="btn" autoFocus onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-danger-fill" onClick={() => void confirm()} disabled={busy || live}>{busy ? 'Deleting…' : 'Delete team'}</button>
        </div>
      </div>
    </div>
  )
}
