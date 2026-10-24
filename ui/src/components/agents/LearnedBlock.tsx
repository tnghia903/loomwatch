import { Lightbulb, X } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

import { plainWords } from '../../lib/chat/findWords'
import { fetchLessons, learnedFrom, tellAllAgents, undoLesson, undoTellAllAgents, type AgentLessons, type Lesson, type LessonsOf } from '../../lib/lessons/client'
import { InlineMarkdown } from '../ui/Markdown'
import { TELL_ALL, TellAllAsk } from '../you/TellAllAsk'

/** "20 Oct": when a lesson was learned, short. */
const day = (at: string) => {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/**
 * What this agent has learned from your feedback on its work (ADR 0078), in its builder: each
 * lesson with where it came from, and Forget. It is in the agent's instructions from its next work
 * on. One of My agents keeps one list in every team that places it.
 *
 * A lesson about you rather than one job offers Tell all my agents: once you say yes, it moves to
 * About you, for every agent, and a line under the list says so, with Undo.
 */
export function LearnedBlock({ of, name, readOnly = false }: { of: LessonsOf; name: string; readOnly?: boolean }) {
  const heading = useId()
  const key = 'savedAgent' in of ? `saved:${of.savedAgent}` : `team:${of.teamPath}#${of.agent}`
  // `moved`: what Tell all my agents moved to About you from here, while this agent stays open.
  const [read, setRead] = useState<{ key: string; state: AgentLessons | null; error: string | null; moved?: Lesson[] } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [asking, setAsking] = useState<string | null>(null)
  // The Tell all my agents button last pressed, for the focus to go back to.
  const asked = useRef<HTMLButtonElement | null>(null)
  // A change that takes away the button pressed sends the keyboard here, by element id: Undo on the
  // line under the list after Tell all my agents, the lesson's own button after that Undo. A layout
  // effect moves it in the same change, so the keyboard is never left on the page in between.
  const focusNext = useRef<string | null>(null)
  useLayoutEffect(() => {
    const id = focusNext.current
    if (!id) return
    focusNext.current = null
    document.getElementById(id)?.focus()
  })
  const cancel = () => {
    setAsking(null)
    asked.current?.focus()
  }
  useEffect(() => {
    const controller = new AbortController()
    fetchLessons(of, controller.signal)
      .then((state) => setRead({ key, state, error: null }))
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return
        setRead({ key, state: null, error: caught instanceof Error ? caught.message : String(caught) })
      })
    return () => controller.abort()
    // `key` names `of` exactly; the object itself is made anew on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` names `of`
  }, [key])
  const current = read?.key === key ? read : null
  const lessons = current?.state?.lessons ?? []
  const moved = current?.moved ?? []
  // One change to the list, by `lesson`: the list as the daemon says it is now, and what moved.
  const change = async (lesson: Lesson, made: () => Promise<{ lessons: Lesson[] }>, movedNow: (moved: Lesson[]) => Lesson[] = (same) => same, focus: string | null = null) => {
    setBusy(lesson.id)
    try {
      const { lessons: now } = await made()
      focusNext.current = focus
      setAsking(null)
      setRead((previous) => (previous?.state ? { ...previous, state: { ...previous.state, lessons: now }, error: null, moved: movedNow(previous.moved ?? []) } : previous))
    } catch (caught) {
      setRead((previous) => (previous ? { ...previous, error: caught instanceof Error ? caught.message : String(caught) } : previous))
    } finally {
      setBusy(null)
    }
  }
  const forget = (lesson: Lesson) => change(lesson, () => undoLesson(of, lesson.id))
  const tellAll = (lesson: Lesson) => change(lesson, () => tellAllAgents(of, lesson.id), (before) => [...before, lesson], `${heading}-moved-${lesson.id}`)
  const moveBack = (lesson: Lesson) => change(lesson, () => undoTellAllAgents(of, lesson.id), (before) => before.filter((other) => other.id !== lesson.id), `${heading}-tell-${lesson.id}`)
  const says = current?.state && !current.state.learns
    ? 'Learning is off for this agent: its team file says learns: false.'
    : lessons.length === 0
      ? moved.length > 0 ? `${name} keeps nothing of its own now.` : `Nothing yet. Tell ${name} what to change about an answer, and it learns from it.`
      : `In its instructions from its next work on. ${lessons.length} of ${current?.state?.max ?? 12}.`
  return (
    <section className="byhand-block learned-block" aria-labelledby={heading}>
      <header className="byhand-block-head">
        <h3 id={heading}>Learned</h3>
        <span className="byhand-block-where">From your feedback</span>
      </header>
      {current && <p className="byhand-block-says">{says}</p>}
      {lessons.length > 0 && (
        <ul className="learned-list">
          {lessons.map((lesson) => (
            <li key={lesson.id} className="learned-item">
              <Lightbulb size={14} className="learned-mark" aria-hidden="true" />
              <div className="learned-body">
                <p className="learned-text"><InlineMarkdown>{lesson.text}</InlineMarkdown></p>
                <p className="learned-from" title={plainWords(lesson.feedback)}>
                  {learnedFrom(lesson)}{lesson.createdAt ? ` · ${day(lesson.createdAt)}` : ''}
                  {lesson.backed > 0 ? ` · liked ${lesson.backed}×` : ''}
                  {lesson.missed > 0 ? ` · missed ${lesson.missed}×` : ''}
                </p>
                {lesson.aboutYou && !readOnly && (
                  <button id={`${heading}-tell-${lesson.id}`} type="button" className="link learned-tell" disabled={busy === lesson.id}
                    onClick={(event) => { asked.current = event.currentTarget; setAsking((open) => (open === lesson.id ? null : lesson.id)) }}
                    aria-expanded={asking === lesson.id} aria-controls={asking === lesson.id ? `${heading}-ask` : undefined} aria-label={`${TELL_ALL}: ${plainWords(lesson.text)}`}>
                    {TELL_ALL}
                  </button>
                )}
                {asking === lesson.id && <p className="learned-ask"><TellAllAsk id={`${heading}-ask`} busy={busy === lesson.id} onAdd={() => void tellAll(lesson)} onCancel={cancel} /></p>}
              </div>
              {!readOnly && (
                <button type="button" className="iconbtn learned-forget" disabled={busy === lesson.id} onClick={() => void forget(lesson)} aria-label={`Forget: ${plainWords(lesson.text)}`} title="Forget">
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {moved.map((lesson) => (
        <p key={lesson.id} className="learned-moved" role="status">
          <Lightbulb size={14} className="learned-mark" aria-hidden="true" />
          <span className="learned-moved-words"><b>All your agents</b> know: <InlineMarkdown>{lesson.text}</InlineMarkdown></span>
          <button id={`${heading}-moved-${lesson.id}`} type="button" className="link" disabled={busy === lesson.id} onClick={() => void moveBack(lesson)} aria-label={`Undo: ${plainWords(lesson.text)}`}>Undo</button>
        </p>
      ))}
      {current?.error && <p className="t-meta" role="alert">{current.error}</p>}
    </section>
  )
}
