import { Check, ChevronDown, ChevronRight, CircleAlert, Square } from 'lucide-react'
import { useId, useState, type CSSProperties } from 'react'

import { plainWords } from '../../lib/chat/findWords'
import { helpersLine, took, type HelperWork } from '../../lib/chat/helpers'
import { useNow } from '../../lib/useNow'
import { AvatarFace } from '../agents/AvatarFace'
import { InlineMarkdown } from '../ui/Markdown'

/**
 * The helpers an agent brought in for a piece of work (ADR 0079), on the piece, under the line that
 * says who is working: how the work is going, at a glance. Its own figure once for each helper in
 * the gutter, a line that counts them, and a row for each part: its title, whether it is working,
 * done or couldn't finish, for how long, and while it works what it is doing now, with Stop.
 *
 * What was said is the talk's: a row opens the talk at the brief the agent wrote that helper and
 * what it sent back, rather than saying them again here. Open while they work, so you watch the
 * parts come in; folded to its one line once the piece is done, where the answer is what you read.
 */
export function Helpers({ helpers, live, lead, name, hue, onShow, onStop }: {
  helpers: readonly HelperWork[]
  /** The piece is still running. */
  live: boolean
  /** The agent's name, for what Stop says it does. */
  lead: string
  name: (id: string) => string
  hue: (id: string) => number
  /** Open the talk at the message that briefed this helper. */
  onShow?: (messageId: string) => void
  /** Stop one helper at work; absent where nothing can be stopped. */
  onStop?: (helperId: string) => Promise<void>
}) {
  const [toggled, setToggled] = useState<boolean | null>(null)
  const open = toggled ?? live
  const list = useId()
  const now = useNow(live)
  if (helpers.length === 0) return null
  const busy = helpers.some((helper) => helper.state === 'working')
  return (
    <section className={`tc-helpers${busy ? ' busy' : ''}`} aria-label={`${lead}’s helpers`}>
      <button type="button" className="tc-helpers-head" aria-expanded={open} aria-controls={list} onClick={() => setToggled(!open)}>
        <span className="tc-helpers-faces" aria-hidden="true" style={{ '--count': helpers.length } as CSSProperties}>
          {helpers.map((helper) => <HelperFace key={helper.id} helper={helper} hue={hue(helper.id)} name={name(helper.id)} size={20} numbered={false} />)}
        </span>
        <span className="tc-helpers-line">{helpersLine(helpers)}</span>
        {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
      </button>
      {open && (
        <ol id={list} className="tc-helpers-list">
          {helpers.map((helper) => <HelperRow key={helper.id} helper={helper} lead={lead} hue={hue(helper.id)} name={name(helper.id)} now={now} onShow={onShow} onStop={live && helper.state === 'working' ? onStop : undefined} />)}
        </ol>
      )}
    </section>
  )
}

/** The agent's own face, small, with the helper's number on it where there is room for one. */
function HelperFace({ helper, hue, name, size = 22, numbered = true }: { helper: HelperWork; hue: number; name: string; size?: number; numbered?: boolean }) {
  return (
    <AvatarFace id={helper.id} hue={hue} size={size} fontSize={9} text={String(helper.number)} title={name} className={`tc-helper-face ${helper.state}`}>
      {numbered && <b className="tc-helper-number">{helper.number}</b>}
    </AvatarFace>
  )
}

const STATE_WORDS: Record<HelperWork['state'], string> = { working: 'working', done: 'done', stopped: 'stopped', failed: 'couldn’t finish' }

function HelperRow({ helper, lead, hue, name, now, onShow, onStop }: { helper: HelperWork; lead: string; hue: number; name: string; now: number; onShow?: (messageId: string) => void; onStop?: (helperId: string) => Promise<void> }) {
  const [stopping, setStopping] = useState(false)
  const time = took(helper.startedAt, helper.finishedAt, now)
  const steps = `${helper.steps} ${helper.steps === 1 ? 'step' : 'steps'}`
  return (
    <li className={`tc-helper ${helper.state}`}>
      <button type="button" className="tc-helper-row" onClick={() => onShow?.(helper.messageId)} disabled={!onShow}
        aria-label={`${name}: ${plainWords(helper.title)}, ${STATE_WORDS[helper.state]}, ${steps}. Show what ${lead} asked it and what it sent back`}>
        <HelperFace helper={helper} hue={hue} name={name} />
        <span className="tc-helper-title"><InlineMarkdown clickable={false}>{helper.title}</InlineMarkdown></span>
        <span className="tc-helper-state" title={steps}>
          {helper.state === 'working' && <span className="chat-dots" aria-hidden="true"><i /><i /><i /></span>}
          {helper.state === 'done' && <Check size={12} aria-hidden="true" />}
          {helper.state === 'failed' && <CircleAlert size={12} aria-hidden="true" />}
          {helper.state === 'stopped' && <Square size={10} aria-hidden="true" />}
          <time>{time}</time>
        </span>
      </button>
      {helper.state === 'working' && (helper.now || onStop) && (
        <p className="tc-helper-now">
          <span>{helper.now ?? 'Starting…'}</span>
          {onStop && (
            <button type="button" className="tc-link danger tc-helper-stop" disabled={stopping} aria-label={`Stop ${name}`} title={`${lead} gets what it has so far and does the rest`}
              onClick={() => { setStopping(true); void onStop(helper.id).catch(() => setStopping(false)) }}>
              <Square size={10} aria-hidden="true" />Stop
            </button>
          )}
        </p>
      )}
    </li>
  )
}
