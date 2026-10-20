import { Lightbulb } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import { inAboutYou, learnedFrom, type Lesson } from '../../lib/lessons/client'
import { TELL_ALL, TellAllAsk } from '../you/TellAllAsk'
import { Appearing } from './Appearing'

/**
 * What the agents learned from your feedback on this piece of work (ADR 0078): one line each,
 * under its answer, with Undo. Resting on a line says where it came from: your words, or the check.
 * It reaches the agent's next work, not work already going.
 *
 * A lesson about you rather than one job also offers Tell all my agents, which asks first and then
 * moves it to About you, for every agent. Its line then says so, and its Undo moves it back.
 */
export function Learned({ lessons, name, onUndo, onTellAll }: { lessons: readonly Lesson[]; name: (id: string) => string; onUndo?: (lesson: Lesson) => Promise<void>; onTellAll?: (lesson: Lesson) => Promise<void> }) {
  if (lessons.length === 0) return null
  return (
    <Appearing reveal className="tc-learned" role="group" aria-label="Learned from this work">
      {/* A lesson that moved, or moved back, is a new line: nothing asked or done on it before carries over. */}
      {lessons.map((lesson) => <LearnedLine key={`${lesson.id}:${lesson.state}`} lesson={lesson} name={name} onUndo={onUndo} onTellAll={onTellAll} />)}
    </Appearing>
  )
}

/**
 * Moving a lesson to About you, or back, makes its line anew once the chat reads again, and the
 * button pressed is gone. `lesson id:state` of the line the keyboard goes to then: its Undo, or its
 * Tell all my agents.
 */
let refocus: string | null = null

function LearnedLine({ lesson, name, onUndo, onTellAll }: { lesson: Lesson; name: (id: string) => string; onUndo?: (lesson: Lesson) => Promise<void>; onTellAll?: (lesson: Lesson) => Promise<void> }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  // Done, and the chat reading again: nothing to press until it has.
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const moved = inAboutYou(lesson)
  const trigger = useRef<HTMLButtonElement>(null)
  const undo = useRef<HTMLButtonElement>(null)
  const askId = useId()
  useEffect(() => {
    if (refocus !== `${lesson.id}:${lesson.state}`) return
    refocus = null
    ;(moved ? undo : trigger).current?.focus()
  }, [lesson.id, lesson.state, moved])
  const cancel = () => {
    setAsking(false)
    trigger.current?.focus()
  }
  const act = async (what: (lesson: Lesson) => Promise<void>, then: Lesson['state'] | null) => {
    setBusy(true)
    setError(null)
    try {
      await what(lesson)
      refocus = then ? `${lesson.id}:${then}` : null
      setAsking(false)
      setDone(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }
  const from = `${learnedFrom(lesson)}: ${lesson.feedback}`
  const offer = !done && onTellAll !== undefined && lesson.aboutYou && !moved
  const canUndo = !asking && !done && onUndo !== undefined
  return (
    <>
      <p className="tc-learned-line" title={moved ? `In About you, for all your agents. ${from}` : from}>
        <Lightbulb size={14} className="tc-learned-mark" aria-hidden="true" />
        <span className="tc-learned-words">{moved ? <b>All your agents</b> : <b>{name(lesson.agentId)}</b>}{moved ? ' know: ' : ' learned: '}{lesson.text}</span>
        {offer && (
          <button ref={trigger} type="button" className="link tc-learned-act" disabled={busy} onClick={() => setAsking((open) => !open)} aria-expanded={asking} aria-controls={asking ? askId : undefined} aria-label={`${TELL_ALL}: ${lesson.text}`}>
            {TELL_ALL}
          </button>
        )}
        {offer && canUndo && <span className="tc-learned-dot" aria-hidden="true">·</span>}
        {canUndo && (
          <button ref={undo} type="button" className="link tc-learned-act" disabled={busy} onClick={() => void act(onUndo, moved ? 'active' : null)} aria-label={`Undo: ${lesson.text}`}>
            Undo
          </button>
        )}
      </p>
      {asking && onTellAll && (
        <p className="tc-learned-ask">
          <TellAllAsk id={askId} busy={busy} onAdd={() => void act(onTellAll, 'dropped')} onCancel={cancel} />
        </p>
      )}
      {error && <p className="chat-failed" role="alert">{error}</p>}
    </>
  )
}
