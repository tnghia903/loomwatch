import { ArrowLeft } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { listNames } from '../../lib/format'
import { displayName } from '../../lib/library/skillStore'
import { SkillsStore } from './SkillsPage'

/**
 * The skills marketplace, opened from an agent's Skills block: the Skills page's store, laid over
 * the whole page rather than gone to, so nothing set on the agent is lost, saved or not. Its one
 * way out is back to that agent, which gets the skills added here as recipe cards (`onClose`).
 *
 * Only skills added with Add go on its pegboard, and only while they are still in LoomWatch (an
 * Undo takes one back). A bring-in can be every skill an app has, so those stay in the list of
 * cards to pin up by hand.
 */
export default function SkillsMarket({ agentName, query = '', onClose }: {
  /** Who the skills are for: "Back to <name>". */
  agentName: string
  /** What was typed in its Skills block and found nothing there. */
  query?: string
  /** Back to the agent, with the names of the skills added here that are still there. */
  onClose: (added: string[]) => void
}) {
  const headingId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const [added, setAdded] = useState<string[]>([])
  const [have, setHave] = useState<ReadonlySet<string> | null>(null)
  const kept = added.filter((name) => !have || have.has(name))
  const close = () => onClose(kept)

  // It takes focus as it opens. Where focus goes back to is the opener's to say: the button that
  // opened it may never have had focus (Safari).
  useEffect(() => { panel.current?.focus({ preventScroll: true }) }, [])

  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      tabIndex={-1}
      className="lw-home lw-skills lw-skills-market"
      // A review sheet or the bring-in sheet takes its own Escape first, and a search box with
      // words in it is cleared by its Escape, not closed with the store.
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return
        if (event.target instanceof HTMLInputElement && event.target.value) return
        event.stopPropagation()
        close()
      }}
    >
      <div className="ground" aria-hidden="true" />
      <header className="home-top lw-skills-market-top">
        <button type="button" className="btn" onClick={close}><ArrowLeft size={14} aria-hidden="true" />Back to {agentName}</button>
        <p className="lw-skills-market-says" role="status">
          {kept.length ? <>{listNames(kept.map(displayName))} will be pinned up on {agentName}.</> : <>What you add here is pinned up on {agentName} when you go back.</>}
        </p>
      </header>
      <SkillsStore
        heading={<span id={headingId}>Find skills for {agentName}</span>}
        intro="Skills teach your agents a kind of work, like filling in PDF forms or writing in your house style. Every agent can use the ones you add."
        initialQuery={query}
        onAdded={(names) => {
          setAdded((current) => [...current, ...names.filter((name) => !current.includes(name))])
          // It is there until the folder, read again just after, says otherwise.
          setHave((current) => new Set([...(current ?? []), ...names]))
        }}
        onFolder={(folder) => setHave(new Set(folder.skills.map((skill) => skill.name)))}
      />
    </div>,
    document.body,
  )
}
