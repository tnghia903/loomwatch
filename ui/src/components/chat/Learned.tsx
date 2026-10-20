import { Lightbulb } from 'lucide-react'
import { useState } from 'react'

import { learnedFrom, type Lesson } from '../../lib/lessons/client'
import { Appearing } from './Appearing'

/**
 * What the agents learned from your feedback on this piece of work (ADR 0078): one line each,
 * under its answer, with Undo. Resting on a line says where it came from: your words, or the check.
 * It reaches the agent's next work, not work already going.
 */
export function Learned({ lessons, name, onUndo }: { lessons: readonly Lesson[]; name: (id: string) => string; onUndo?: (lesson: Lesson) => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (lessons.length === 0) return null
  const undo = async (lesson: Lesson) => {
    if (!onUndo) return
    setBusy(lesson.id)
    setError(null)
    try {
      await onUndo(lesson)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }
  return (
    <Appearing reveal className="tc-learned" role="group" aria-label="Learned from this work">
      {lessons.map((lesson) => (
        <p key={lesson.id} className="tc-learned-line" title={`${learnedFrom(lesson)}: ${lesson.feedback}`}>
          <Lightbulb size={14} className="tc-learned-mark" aria-hidden="true" />
          <span className="tc-learned-words"><b>{name(lesson.agentId)}</b> learned: {lesson.text}</span>
          {onUndo && (
            <button type="button" className="link tc-learned-undo" disabled={busy === lesson.id} onClick={() => void undo(lesson)} aria-label={`Undo: ${lesson.text}`}>
              Undo
            </button>
          )}
        </p>
      ))}
      {error && <p className="chat-failed" role="alert">{error}</p>}
    </Appearing>
  )
}
