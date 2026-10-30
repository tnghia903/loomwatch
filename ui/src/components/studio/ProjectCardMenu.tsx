import { ChevronDown, MoreHorizontal } from '../ui/icon'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

import { listNames } from '../../lib/format'
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
 * The "…" on a team in no project, under "Not in a project" on Home (ADR 0100): what is done to the
 * team itself. Moving it into a project has its own button beside it.
 */
export function TeamCardMenu({ name, onDelete }: { name: string; onDelete: () => void }) {
  return (
    <CardMenu label={`More for ${name}`} title="More">
      {(pick) => <button type="button" role="menuitem" className="menu-alert" onClick={pick(onDelete)}>Delete team…</button>}
    </CardMenu>
  )
}

/**
 * A team in no project's one step into one of your projects: the button opens the list, a pick puts
 * it there. "Add", as in a room: the same team can work in more than one (ADR 0103).
 */
export function MoveToProject({ name, projects, onMove }: { name: string; projects: readonly { id: string; name: string; mark?: string }[]; onMove: (project: string) => void }) {
  return (
    <CardMenu label={`Add to a project: ${name}`} title={null} face={<>Add to a project</>} className="move-to-project">
      {(pick) => projects.map((project) => (
        <button key={project.id} type="button" role="menuitem" onClick={pick(() => onMove(project.id))}><ProjectMark id={project.id} mark={project.mark} />{project.name}</button>
      ))}
    </CardMenu>
  )
}

/**
 * A team's "…" in a project's room (ADR 0103): put it into another project as well, take it out of
 * this one, or delete it. The same team in another project keeps its own work there.
 */
export function TeamPlacesMenu({ name, here, projects, onAdd, onTakeOut, onDelete }: {
  name: string
  /** This project's name. */
  here: string
  /** The projects it doesn't work in yet. */
  projects: readonly { id: string; name: string; mark?: string }[]
  onAdd: (project: string) => void
  onTakeOut: () => void
  onDelete: () => void
}) {
  return (
    <CardMenu label={`More for ${name}`} title="More" className="room-team-move">
      {(pick) => <PlacesItems here={here} projects={projects} onAdd={onAdd} onTakeOut={onTakeOut} onDelete={onDelete} pick={pick} />}
    </CardMenu>
  )
}

/** Its items, which start again at the top each time the menu opens. */
function PlacesItems({ here, projects, onAdd, onTakeOut, onDelete, pick }: { here: string; projects: readonly { id: string; name: string; mark?: string }[]; onAdd: (project: string) => void; onTakeOut: () => void; onDelete: () => void; pick: (act: () => void) => () => void }) {
  const [adding, setAdding] = useState(false)
  if (adding) {
    return (
      <>
        <span className="room-team-move-head" aria-hidden="true">Add to</span>
        {/* The list takes the place of the item that opened it: focus moves to its first project. */}
        {projects.map((project, at) => (
          <button key={project.id} type="button" role="menuitem" autoFocus={at === 0} onClick={pick(() => onAdd(project.id))}><ProjectMark id={project.id} mark={project.mark} />{project.name}</button>
        ))}
      </>
    )
  }
  return (
    <>
      {projects.length > 0 && <button type="button" role="menuitem" onClick={() => setAdding(true)}>Add to another project</button>}
      <button type="button" role="menuitem" onClick={pick(onTakeOut)}>Take out of {here}</button>
      <span className="menu-rule" role="separator" />
      <button type="button" role="menuitem" className="menu-alert" onClick={pick(onDelete)}>Delete team…</button>
    </>
  )
}

/**
 * Taking a team out of a project where it is one of several places (ADR 0103): this project loses
 * it and its work here, and it keeps working in the others.
 */
export function TakeOutDialog({ name, here, others, onTakeOut, onClose }: { name: string; here: string; others: readonly string[]; onTakeOut: () => Promise<void>; onClose: () => void }) {
  const titleId = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirm = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onTakeOut()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setBusy(false)
    }
  }
  return (
    <div className="lw-scrim dim" onMouseDown={() => { if (!busy) onClose() }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} className="pop e2 lw-deleteteam" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose() } }}>
        <h2 id={titleId}>Take “{name}” out of {here}?</h2>
        <p>It keeps working in {listNames(others)}. Its chat and work leave {here}.</p>
        <p title=".trash, inside your teams folder">LoomWatch keeps a copy and its past runs, so they come back if you restore it.</p>
        {error && <p role="alert" className="dt-alert">{error}</p>}
        <div className="dt-acts">
          <button type="button" className="btn" autoFocus onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-danger-fill" onClick={() => void confirm()} disabled={busy}>{busy ? 'Taking out…' : 'Take out'}</button>
        </div>
      </div>
    </div>
  )
}

/**
 * A "…" over a card on Home, above the link the card's name stretches over it; with a `face`, a
 * button in words that opens a list the same way.
 */
export function CardMenu({ label, title, face, className = 'room-card-menu', children }: { label: string; title: string | null; face?: ReactNode; className?: string; children: (pick: (act: () => void) => () => void) => ReactNode }) {
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
    <span className={className} ref={box}>
      {face
        ? <button type="button" className="btn" aria-label={label} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((value) => !value)}>{face}<ChevronDown size={14} aria-hidden="true" /></button>
        : <button type="button" className="iconbtn" aria-label={label} title={title ?? undefined} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((value) => !value)}><MoreHorizontal size={16} aria-hidden="true" /></button>}
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
