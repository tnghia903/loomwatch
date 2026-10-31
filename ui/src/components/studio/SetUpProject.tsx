import { Folder, X } from '../ui/icon'
import { useRef, useState } from 'react'

import type { FolderEntry } from '../../lib/knowledge/client'
import { FolderPicker } from '../canvas/FolderPicker'
import { LoomMark } from '../ui/glyphs'

/** What a project starts from: the person's words, and the folder they pointed at. */
export interface ProjectStart {
  words: string
  folder: FolderEntry | null
}

const EXAMPLES = ['A weekly news brief', 'Plan a trip', 'My thesis']

/**
 * A new project starts from one question (ADR 0097): what you are working on, a folder if its files
 * are somewhere, and Set up project, which has Ask draft the room for you to see before anything
 * runs. On an empty Home it stands alone; otherwise it opens from New project.
 */
export function SetUpProject({ onSetUp, unavailable = null, asking = false, onClose, initial = '' }: {
  onSetUp: (start: ProjectStart) => void
  /** Why Ask can't answer now, shown instead of the hint. */
  unavailable?: string | null
  /** Ask's panel is open beside it, so it says where the answer comes. */
  asking?: boolean
  /** Shown as a dialog, closed with this. */
  onClose?: () => void
  /** Words to start from: what was asked of Ask on Home (ADR 0097, ruling 6). */
  initial?: string
}) {
  const [words, setWords] = useState(initial)
  const [folder, setFolder] = useState<FolderEntry | null>(null)
  const [picking, setPicking] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  // With nothing said yet, pressing it puts you where to say it: it stays the screen's one gold button.
  const submit = () => {
    if (unavailable) return
    if (!words.trim()) { field.current?.focus(); return }
    onSetUp({ words: words.trim(), folder })
  }
  const form = (
    <form className="set-up-project" data-tour="set-up-project" onSubmit={(event) => { event.preventDefault(); submit() }}>
      <LoomMark size={56} />
      <h1 id="set-up-title">What are you working on?</h1>
      <div className="set-up-row">
        <label className="set-up-words">
          <span className="visually-hidden">What you are working on</span>
          <input ref={field} value={words} maxLength={4000} autoFocus placeholder="My final-year project. The files are in Documents." onChange={(event) => setWords(event.target.value)} />
        </label>
        <button type="button" className="iconbtn set-up-folder" aria-label={folder ? `Folder: ${folder.name}. Choose another` : 'Add a folder'} title={folder ? folder.path : 'Add a folder'} onClick={() => setPicking(true)}>
          <Folder size={17} aria-hidden="true" />
        </button>
        <button type="submit" className="btn btn-primary" disabled={Boolean(unavailable)}>Set up project</button>
      </div>
      {folder && (
        <p className="set-up-chosen">
          <Folder size={14} aria-hidden="true" />{folder.name}
          <button type="button" className="iconbtn" aria-label={`Take out ${folder.name}`} onClick={() => setFolder(null)}><X size={13} aria-hidden="true" /></button>
        </p>
      )}
      <p className="set-up-hint">{unavailable ?? (asking ? 'Ask answers beside this. You see the team before anything runs.' : 'You see the team before anything runs.')}</p>
      <div className="set-up-examples">
        {EXAMPLES.map((example) => <button key={example} type="button" className="chip" onClick={() => setWords(example)}>{example}</button>)}
      </div>
      {picking && (
        <FolderPicker
          title="The project’s folder"
          note="Every agent in the project may read what is in it, without asking. It is linked, not copied."
          verb="Use"
          onChoose={(chosen) => { setFolder(chosen); setPicking(false) }}
          onClose={() => setPicking(false)}
        />
      )}
    </form>
  )
  if (!onClose) return <section className="set-up-card" aria-labelledby="set-up-title">{form}</section>
  return (
    <div className="set-up-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="set-up-card dialog" role="dialog" aria-modal="true" aria-labelledby="set-up-title" onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}>
        <button type="button" className="iconbtn set-up-close" aria-label="Close" onClick={onClose}><X size={15} aria-hidden="true" /></button>
        {form}
      </section>
    </div>
  )
}
