import { FilePlus2, FolderPlus } from 'lucide-react'
import { useRef, useState } from 'react'

import { addTeamFile } from '../../lib/knowledge/client'
import { chosenName } from '../../lib/knowledge/chosen'
import { FolderPicker } from './FolderPicker'

/** A folder or file the operator chose, ready to become a card (ADR 0042). */
export interface ChosenSource {
  name: string
  path: string
  source: 'Added file' | 'Linked folder'
}

export interface AddSourceProps {
  /** The open team file. An added file is copied beside it, so an unsaved team cannot take one. */
  teamPath?: string | null
  /** Called once per pick with everything chosen, so files added together land as one change. */
  onAdd: (sources: ChosenSource[]) => void
}

/**
 * Add folder… and Add file… for the add panel (ADR 0042). Each makes a card no agent reads yet;
 * the operator connects it to every agent that should, the way a skill card is connected. The
 * agent panel's own Add folder… and Add file… connect what they add to that agent at once.
 */
export function AddSource({ teamPath, onAdd }: AddSourceProps) {
  const [picking, setPicking] = useState(false)
  const [adding, setAdding] = useState(false)
  const [notes, setNotes] = useState<{ text: string; failed: boolean }[]>([])
  const fileInput = useRef<HTMLInputElement>(null)

  const addFiles = async (files: readonly File[]) => {
    if (!teamPath || files.length === 0) return
    setAdding(true)
    const added: ChosenSource[] = []
    const next: { text: string; failed: boolean }[] = []
    for (const file of files) {
      try {
        const stored = await addTeamFile(teamPath, file)
        added.push({ name: stored.name, path: stored.path, source: 'Added file' })
        if (stored.note) next.push({ text: `${stored.name}: ${stored.note}`, failed: false })
      } catch (caught) {
        next.push({ text: `${file.name} was not added: ${caught instanceof Error ? caught.message : String(caught)}`, failed: true })
      }
    }
    if (added.length > 0) onAdd(added)
    setNotes(next)
    setAdding(false)
  }

  return (
    <div className="palette-sources">
      <div className="agent-context-add">
        <button type="button" className="link t-meta" onClick={() => setPicking(true)}><FolderPlus size={13} aria-hidden="true" />Add folder…</button>
        <button type="button" className="link t-meta" disabled={!teamPath || adding} onClick={() => fileInput.current?.click()}><FilePlus2 size={13} aria-hidden="true" />{adding ? 'Adding…' : 'Add file…'}</button>
        <input ref={fileInput} type="file" multiple hidden aria-label="Files to add to the team" onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void addFiles(files) }} />
      </div>
      {!teamPath && <p className="palette-hint">Save the team to add a file: it is copied next to the team file.</p>}
      {notes.length > 0 && (
        <ul className="agent-context-notes" aria-live="polite">
          {notes.map((note) => <li key={note.text} className={`t-meta ${note.failed ? 'failed' : ''}`} role={note.failed ? 'alert' : undefined}>{note.text}</li>)}
        </ul>
      )}
      {picking && (
        <FolderPicker
          note="Agents you connect to it are given its listing and README, and may open any file in it. They never change it."
          onClose={() => setPicking(false)}
          onChoose={(folder) => {
            setPicking(false)
            onAdd([{ name: chosenName(folder.path) || folder.name, path: folder.path, source: 'Linked folder' }])
          }}
        />
      )}
    </div>
  )
}
