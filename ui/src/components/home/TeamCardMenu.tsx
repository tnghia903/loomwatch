import { Ellipsis, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

/**
 * The "…" on a Home team card: the team's own actions, kept off the card itself because the card
 * is one big button and a button cannot hold another.
 */
export function TeamCardMenu({ name, onDelete }: { name: string; onDelete: () => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    return () => window.removeEventListener('mousedown', onPointerDown)
  }, [open])

  return (
    <div ref={root} className="home-card-acts" onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); toggle.current?.focus() } }}>
      {/* Named "More actions" on every card, told apart by its description: a name that repeated the
          team's would make every "find the Research desk button" ambiguous. */}
      <button ref={toggle} type="button" className="iconbtn home-card-more" aria-label="More actions" title={`More actions for ${name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Ellipsis size={16} aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" aria-label={`${name} actions`} className="pop e2 home-card-menu">
          <button type="button" role="menuitem" className="pop-row alert" autoFocus onClick={() => { setOpen(false); onDelete() }}>
            <Trash2 size={15} aria-hidden="true" />
            <span className="name t-body">Delete team…</span>
          </button>
        </div>
      )}
    </div>
  )
}
