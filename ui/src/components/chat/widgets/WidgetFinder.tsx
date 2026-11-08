import { useEffect, useRef, useState } from 'react'

import { walkFinder } from '../../../lib/widgets/finder'
import type { WidgetSpec, WidgetState } from '../../../lib/widgets/types'
import { LIVE } from './WidgetChoices'

type Finder = Extract<WidgetSpec, { kind: 'finder' }>

/**
 * A finder (ADR 0114, amended 8 November): one question at a time, the answers to tap under it,
 * and at the end of your path the outcome for your case, at once and without another run. Its
 * answers wear a quiz's look, not choices': a tap answers here, it sends nothing. What you answered
 * stays above the question, each a row you tap to change it, with one hint line saying so. Asked
 * again, the answer you gave before is marked, and tapping it brings back the rest of your path,
 * so a stray tap costs nothing. Your path is kept, and the next work reads it. `disabled` while the
 * answer is still being written.
 */
export function WidgetFinder({ spec, state, onAnswer, error, disabled = false }: { spec: Finder; state?: WidgetState; onAnswer: (answers: number[]) => void; error: string | null; disabled?: boolean }) {
  const taken = state && 'answers' in state ? state.answers : []
  const walk = walkFinder(spec, taken)
  const picks = walk.path.map((step) => step.picked)
  // The path you had before you went back to change an answer, while it still starts as yours does.
  const [before, setBefore] = useState<number[] | null>(null)
  const earlier = before && before.length > picks.length && picks.every((pick, at) => before[at] === pick) ? before : null
  const gave = earlier?.[picks.length]
  // After a tap the button you tapped goes away: focus moves on to the next question's first
  // answer, or to the outcome, so a keyboard keeps its place.
  const box = useRef<HTMLDivElement>(null)
  const moved = useRef(false)
  useEffect(() => {
    if (!moved.current) return
    moved.current = false
    box.current?.querySelector<HTMLElement>('.wg-check-choice, .wg-outcome')?.focus()
  })
  const go = (answers: number[]) => {
    moved.current = true
    onAnswer(answers)
  }
  const answer = (which: number) => {
    setBefore(null)
    go(earlier && which === gave ? earlier : [...picks, which])
  }
  return (
    <section className="wg wg-finder" aria-label={spec.title} title={disabled ? LIVE : undefined}>
      <p className="wg-title">{spec.title}</p>
      {walk.path.length > 0 && (
        <div className="wg-trail-wrap">
          <ol className="wg-trail">
            {walk.path.map((step, at) => (
              <li key={at}>
                <button
                  type="button"
                  className="wg-trail-step"
                  disabled={disabled}
                  aria-label={`${step.question.text} ${step.answer.label}. Change this answer`}
                  title="Change this answer"
                  onClick={() => {
                    setBefore(picks)
                    go(picks.slice(0, at))
                  }}
                >
                  <span className="wg-trail-q">{step.question.text}</span>
                  <b className="wg-trail-a">{step.answer.label}</b>
                </button>
              </li>
            ))}
          </ol>
          <p className="wg-trail-hint" aria-hidden="true">Tap an answer to change it.</p>
        </div>
      )}
      {/* One place a screen reader hears: the question waiting on you, or where your answers led. */}
      <div ref={box} aria-live="polite">
        {walk.asking && (
          <div className="wg-finder-ask" role="group" aria-label={walk.asking.question.text}>
            <p className="wg-finder-q">
              {spec.questions.length > 1 && <span className="wg-q-n">{walk.path.length + 1}</span>}
              {walk.asking.question.text}
            </p>
            <div className="wg-check-choices">
              {walk.asking.question.answers.map((one, which) => (
                <button
                  key={which}
                  type="button"
                  className={`wg-check-choice${which === gave ? ' on' : ''}`}
                  aria-pressed={earlier ? which === gave : undefined}
                  disabled={disabled}
                  onClick={() => answer(which)}
                >
                  <span>{one.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {walk.outcome && (
          <div className="wg-outcome" tabIndex={-1}>
            <p className="wg-outcome-label">{walk.outcome.label}</p>
            {walk.outcome.text && <p className="wg-outcome-text">{walk.outcome.text}</p>}
          </div>
        )}
      </div>
      {error && <p className="chat-failed" role="alert">{error}</p>}
    </section>
  )
}
