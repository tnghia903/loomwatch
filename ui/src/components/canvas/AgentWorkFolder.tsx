import { Folder } from 'lucide-react'
import { useState } from 'react'

import type { AgentConfig } from '../../lib/team-file/types'
import { ownFolderReason, teamFolderOf, workFolder } from '../../lib/team-file/workFolder'
import { FolderPicker } from './FolderPicker'

export interface AgentWorkFolderProps {
  agent: AgentConfig
  readOnly?: boolean
  onChange: (cwd: string) => void
  /** A problem the team file has with `spawn.cwd`, e.g. it is missing. */
  problem?: { message: string; weight: 'error' | 'incomplete' }
  /** The open team file, so "the team's folder" can say where that is. */
  teamPath?: string | null
}

// Only an agent left in the team's folder is moved (ADR 0042); choosing a folder keeps it there.
const OWN_FOLDER_NOTE: Record<'connected' | 'edits', string> = {
  connected: 'Something is connected, so instead of the team’s folder it works in a folder LoomWatch prepares for it, and reads what is connected from there. Choose a folder to have it work on a project.',
  edits: 'It can edit files, so it gets a folder of its own and never changes your team files. Choose a folder to have it work there instead.',
}

/**
 * WORKS IN (ADR 0039): the one setting the old PROCESS zone held that changes what an agent does.
 * The folder it starts in is where it may read and, with the switches below, edit files and run
 * commands (ADR 0037), so it is chosen like the folders given as knowledge, not typed as a path
 * relative to the team file.
 */
export function AgentWorkFolder({ agent, readOnly = false, onChange, problem, teamPath }: AgentWorkFolderProps) {
  const [picking, setPicking] = useState(false)
  const cwd = agent.spawn?.cwd
  const folder = workFolder(cwd)
  const own = ownFolderReason(agent)
  const chosen = folder.kind === 'chosen' ? folder : null

  let title: string
  let place: string
  let note: string
  const teamFolder = teamFolderOf(teamPath)
  if (own) {
    title = 'Its own folder'
    place = 'Prepared by LoomWatch, beside the team file'
    note = OWN_FOLDER_NOTE[own]
  } else if (chosen) {
    title = chosen.name
    place = chosen.path
    note = 'Its project: it starts here and may read the files in it. It changes files or runs commands here only if you allow it below. Folders and files connected to it are read only.'
  } else {
    title = 'The team’s folder'
    place = teamFolder ?? 'Where the team file is saved'
    note = 'It starts where the team file is saved and may read the files there, including your other teams. To have it work on a project, choose that project’s folder.'
  }
  const canChoose = !readOnly
  // A missing `cwd` is a problem the file reports; putting the default back fixes it.
  const canReset = !readOnly && (chosen !== null || !cwd?.trim())

  return (
    <div className={`agent-context agent-work-folder field ${problem ? (problem.weight === 'error' ? 'error' : 'needs') : ''}`}>
      <div className="agent-work-folder-row">
        <Folder size={14} aria-hidden="true" />
        <span className="agent-context-name"><b className="t-body">{title}</b><span className="t-meta" title={place}>{place}</span></span>
      </div>
      <div className="t-meta agent-context-note">{note}</div>
      {problem && <span className="hint t-meta">{problem.message}</span>}
      {(canChoose || canReset) && (
        <div className="agent-context-add">
          {canChoose && <button type="button" className="link t-meta" data-agent-field="cwd" onClick={() => setPicking(true)}>{chosen ? 'Change folder…' : 'Choose folder…'}</button>}
          {canReset && <button type="button" className="link t-meta" onClick={() => onChange('.')}>Use the team’s folder</button>}
        </div>
      )}
      {picking && (
        <FolderPicker
          title="Choose where it works"
          note="The agent starts in this folder and may read the files in it. It changes files or runs commands there only if you allow it."
          verb="Use"
          start={chosen?.path.startsWith('/') ? chosen.path : undefined}
          onClose={() => setPicking(false)}
          onChoose={(picked) => {
            setPicking(false)
            onChange(picked.path)
          }}
        />
      )}
    </div>
  )
}
