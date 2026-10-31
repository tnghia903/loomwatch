import { useState, type Ref } from 'react'

import { ToldWhy } from '../../lib/files/reader'
import { AvatarFace } from '../agents/AvatarFace'

interface ChangeFieldProps {
  /** Who makes the change: the agent who made the file, or the teammate chosen. */
  agent: string
  /** Teammates who could make it instead, as faces. */
  others: readonly string[]
  /** The agent who made the file, said so beside its face. */
  maker: string | null
  name: (id: string) => string
  hue: (id: string) => number
  onChoose: (id: string) => void
  /** Over words being typed into, it opens as one button, so selecting words to type over them is never in its way. */
  folded: boolean
  /** Leave the change; rejects with why it couldn't be left. */
  onAdd: (words: string) => Promise<void>
  /** Opened from its one button: it is larger now. */
  onOpened?: () => void
  ref?: Ref<HTMLDivElement>
  style: { top: number; left: number }
  below: boolean
}

/**
 * Leaving a change on a marked part for an agent (ADR 0107), while Make changes is on: what should
 * change there, and who makes it. It waits on the file, with the others, until Send. The faces
 * give it to a teammate instead, as the pill's faces ask one.
 */
export function ChangeField({ agent, others, maker, name, hue, onChoose, folded, onAdd, onOpened, ref, style, below }: ChangeFieldProps) {
  const [open, setOpen] = useState(!folded)
  const [words, setWords] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const who = name(agent)
  const add = () => {
    const said = words.trim()
    if (!said || adding) return
    setAdding(true)
    setProblem(null)
    void onAdd(said).then(
      () => setAdding(false),
      (caught: unknown) => {
        setAdding(false)
        // The daemon's own sentence says what to do; with none, trying again is all there is.
        setProblem(caught instanceof ToldWhy ? caught.message : 'Couldn’t add it. Try again.')
      },
    )
  }
  if (!open) {
    return (
      <div ref={ref} className={`rd-change-field folded${below ? ' below' : ''}`} style={style} data-reader-chrome onMouseDown={(event) => event.preventDefault()}>
        <button type="button" className="rd-change-open" onClick={() => { setOpen(true); onOpened?.() }} title={`Tell ${who} what to change here`}>
          <AvatarFace id={agent} hue={hue(agent)} size={20} fontSize={8} text={initials(who)} />
          Change this…
        </button>
      </div>
    )
  }
  return (
    <div ref={ref} className={`rd-change-field${below ? ' below' : ''}`} style={style} role="group" aria-label={`What should ${who} change?`} data-reader-chrome>
      <label className="rd-change-ask">
        <AvatarFace id={agent} hue={hue(agent)} size={20} fontSize={8} text={initials(who)} />
        <span>What should <b>{who}</b> change?</span>
        <textarea autoFocus rows={2} value={words} onChange={(event) => setWords(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              add()
            }
          }} />
      </label>
      <div className="rd-change-row">
        {others.length > 0 && (
          <span className="rd-change-others" role="group" aria-label="Or give it to someone else">
            {others.map((id) => {
              const label = id === maker ? `Give it to ${name(id)}, who made this` : `Give it to ${name(id)}`
              return (
                <button key={id} type="button" className="rd-change-other" onClick={() => onChoose(id)} aria-label={label} title={label}>
                  <AvatarFace id={id} hue={hue(id)} size={20} fontSize={8} text={initials(name(id))} />
                </button>
              )
            })}
          </span>
        )}
        <button type="button" className="rd-change-add" onClick={add} disabled={!words.trim() || adding} title="Waits here until you press Send">Add</button>
      </div>
      {problem && <p className="rd-change-problem" role="alert">{problem}</p>}
    </div>
  )
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : name.slice(0, 2)).toUpperCase()
}
