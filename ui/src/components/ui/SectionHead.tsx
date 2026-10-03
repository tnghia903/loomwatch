import { CircleHelp } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'

export interface SectionHeadProps {
  title: string
  /** The heading's own look, which differs between the panels that use it. */
  className?: string
  as?: 'div' | 'h3' | 'span'
  /** How the section works, kept one click away so the section itself shows only state. */
  explain?: ReactNode
}

/**
 * A section heading with its explanation behind a "?". Panels show what is set at a glance; the
 * sentences that say why live here, so a newcomer can still read them and nobody else has to.
 * The button sits beside the heading, not in it, so the heading's name stays its title.
 */
export function SectionHead({ title, className = '', as: Tag = 'div', explain }: SectionHeadProps) {
  const [open, setOpen] = useState(false)
  const id = useId()
  if (!explain) return <Tag className={className}>{title}</Tag>
  return (
    <>
      <div className="section-head">
        <Tag className={className}>{title}</Tag>
        <button type="button" className={`explain-toggle ${open ? 'on' : ''}`} aria-expanded={open} aria-controls={id} aria-label={`About ${title}`} title={open ? 'Hide' : 'What this means'} onClick={() => setOpen((current) => !current)}>
          <CircleHelp size={12} aria-hidden="true" />
        </button>
      </div>
      {open && <div id={id} className="explain-text" role="note">{explain}</div>}
    </>
  )
}
