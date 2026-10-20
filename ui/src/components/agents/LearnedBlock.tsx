import { Lightbulb, X } from 'lucide-react'
import { useEffect, useId, useState } from 'react'

import { fetchLessons, learnedFrom, undoLesson, type AgentLessons, type Lesson, type LessonsOf } from '../../lib/lessons/client'

/** "20 Oct": when a lesson was learned, short. */
const day = (at: string) => {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/**
 * What this agent has learned from your feedback on its work (ADR 0078), in its builder: each
 * lesson with where it came from, and Forget. It is in the agent's instructions from its next work
 * on. One of My agents keeps one list in every team that places it.
 */
export function LearnedBlock({ of, name, readOnly = false }: { of: LessonsOf; name: string; readOnly?: boolean }) {
  const heading = useId()
  const key = 'savedAgent' in of ? `saved:${of.savedAgent}` : `team:${of.teamPath}#${of.agent}`
  const [read, setRead] = useState<{ key: string; state: AgentLessons | null; error: string | null } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
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
  const forget = async (lesson: Lesson) => {
    setBusy(lesson.id)
    try {
      const { lessons: now } = await undoLesson(of, lesson.id)
      setRead((previous) => (previous?.state ? { ...previous, state: { ...previous.state, lessons: now }, error: null } : previous))
    } catch (caught) {
      setRead((previous) => (previous ? { ...previous, error: caught instanceof Error ? caught.message : String(caught) } : previous))
    } finally {
      setBusy(null)
    }
  }
  const says = current?.state && !current.state.learns
    ? 'Learning is off for this agent: its team file says learns: false.'
    : lessons.length === 0
      ? `Nothing yet. Tell ${name} what to change about an answer, and it learns from it.`
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
                <p className="learned-text">{lesson.text}</p>
                <p className="learned-from" title={lesson.feedback}>
                  {learnedFrom(lesson)}{lesson.createdAt ? ` · ${day(lesson.createdAt)}` : ''}
                  {lesson.backed > 0 ? ` · liked ${lesson.backed}×` : ''}
                  {lesson.missed > 0 ? ` · missed ${lesson.missed}×` : ''}
                </p>
              </div>
              {!readOnly && (
                <button type="button" className="iconbtn learned-forget" disabled={busy === lesson.id} onClick={() => void forget(lesson)} aria-label={`Forget: ${lesson.text}`} title="Forget">
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {current?.error && <p className="t-meta" role="alert">{current.error}</p>}
    </section>
  )
}
