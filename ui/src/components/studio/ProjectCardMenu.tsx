import { MoreHorizontal } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

import { ProjectMark } from './RoomCard'

/** What a project's "…" on Home does, each one by its own dialog or save. */
export interface ProjectCardActions {
  onRename: () => void
  onHide: () => void
  onDelete: () => void
}

/**
 * A project's "…" on its card, tile or row on Home (ADR 0100): rename it, hide or show it, and delete
 * it, without opening it first. Inside the project, its own "…" holds the same.
 */
export function ProjectCardMenu({ name, putAway = false, onRename, onHide, onDelete }: ProjectCardActions & { name: string; putAway?: boolean }) {
  return (
    <CardMenu label={`Project settings for ${name}`} title="Project settings">
      {(pick) => (
        <>
          <button type="button" role="menuitem" onClick={pick(onRename)}>Rename…</button>
          <button type="button" role="menuitem" onClick={pick(onHide)}>{putAway ? 'Show on Home' : 'Hide from Home'}</button>
          <span className="menu-rule" role="separator" />
          <button type="button" role="menuitem" className="menu-alert" onClick={pick(onDelete)}>Delete project…</button>
        </>
      )}
    </CardMenu>
  )
}

/**
 * The "…" on the card of a team in no project, the way a deleted project leaves its teams (ADR
 * 0100): move it into one of your projects, or delete it, from Home.
 */
export function TeamCardMenu({ name, ...items }: { name: string } & Omit<TeamMenuItems, 'pick'>) {
  return <CardMenu label={`Team settings for ${name}`} title="Team settings">{(pick) => <TeamItems {...items} pick={pick} />}</CardMenu>
}

interface TeamMenuItems {
  projects: readonly { id: string; name: string; mark?: string }[]
  onMove: (project: string) => void
  onDelete: () => void
  pick: (act: () => void) => () => void
}

/** Its items, which start again at the top each time the menu opens. */
function TeamItems({ projects, onMove, onDelete, pick }: TeamMenuItems) {
  const [moving, setMoving] = useState(false)
  if (moving) {
    return projects.map((project) => (
      <button key={project.id} type="button" role="menuitem" onClick={pick(() => onMove(project.id))}><ProjectMark id={project.id} mark={project.mark} />{project.name}</button>
    ))
  }
  return (
    <>
      <button type="button" role="menuitem" onClick={() => setMoving(true)} disabled={projects.length === 0} title={projects.length === 0 ? 'Set up a project first' : undefined}>Move to a project</button>
      <span className="menu-rule" role="separator" />
      <button type="button" role="menuitem" className="menu-alert" onClick={pick(onDelete)}>Delete team…</button>
    </>
  )
}

/** A "…" over a card on Home, above the link the card's name stretches over it. */
function CardMenu({ label, title, children }: { label: string; title: string; children: (pick: (act: () => void) => () => void) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', escape) }
  }, [open])
  const pick = (act: () => void) => () => { setOpen(false); act() }
  return (
    <span className="room-card-menu" ref={box}>
      <button type="button" className="iconbtn" aria-label={label} title={title} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((value) => !value)}><MoreHorizontal size={16} aria-hidden="true" /></button>
      {open && <span className="idle-agent-menu" role="menu" aria-label={label}>{children(pick)}</span>}
    </span>
  )
}

/** Rename a project from Home, where its name has no field of its own. */
export function RenameProjectDialog({ name, onSave, onClose }: { name: string; onSave: (name: string) => Promise<void>; onClose: () => void }) {
  const titleId = useId()
  const [text, setText] = useState(name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    if (busy || !text.trim()) return
    setBusy(true)
    setError(null)
    try {
      await onSave(text.trim())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setBusy(false)
    }
  }
  return (
    <div className="lw-scrim dim" onMouseDown={() => { if (!busy) onClose() }}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="pop e2 lw-deleteteam" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose() } }}>
        <form onSubmit={(event) => { event.preventDefault(); void save() }}>
          <h2 id={titleId}>Rename project</h2>
          <input autoFocus className="input" aria-label="Project name" value={text} maxLength={80} onChange={(event) => setText(event.target.value)} disabled={busy} />
          {error && <p role="alert" className="dt-alert">{error}</p>}
          <div className="dt-acts">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>{busy ? 'Renaming…' : 'Rename'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
