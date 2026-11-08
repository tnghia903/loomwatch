import { quizScore } from '../../../lib/widgets/quiz'
import type { WidgetSpec, WidgetState } from '../../../lib/widgets/types'
import { Check, X } from '../../ui/icon'
import { LIVE } from './WidgetChoices'

type Quiz = Extract<WidgetSpec, { kind: 'quiz' }>

/**
 * A quiz (ADR 0114, amended 8 November): a few questions on what the answer explains. Tap a
 * choice and the question settles: yours marked right or not, the right one marked, and why. A
 * mark is its glyph and its words, never its colour alone, and a choice that isn't right is quiet
 * rather than red: it is part of learning, not something wrong. What you picked is kept, and the
 * next work reads what you missed. Once every question is answered, "Start again" clears them
 * ("Try again" in the chat reruns work, which costs).
 * `disabled` while the answer is still being written.
 */
export function WidgetQuiz({ spec, state, onPick, error, disabled = false }: { spec: Quiz; state?: WidgetState; onPick: (picked: (number | null)[]) => void; error: string | null; disabled?: boolean }) {
  const kept = state && 'picked' in state ? state.picked : []
  const picked = spec.checks.map((_, at) => kept[at] ?? null)
  const { answered, right } = quizScore(spec, picked)
  const done = answered === spec.checks.length
  return (
    <section className="wg wg-quiz" aria-label={spec.title} title={disabled ? LIVE : undefined}>
      <p className="wg-title">
        {spec.title}
        <span className="wg-count" aria-live="polite">{done ? `${right} of ${spec.checks.length} right` : `${answered} of ${spec.checks.length} answered`}</span>
      </p>
      <ol className="wg-checks">
        {spec.checks.map((check, at) => {
          const pick = picked[at]
          const settled = pick !== null
          return (
            <li key={at} className="wg-check">
              <p className="wg-check-q">
                {spec.checks.length > 1 && <span className="wg-q-n">{at + 1}</span>}
                {check.question}
              </p>
              <div className="wg-check-choices" role="group" aria-label={check.question}>
                {check.choices.map((choice, which) => {
                  const isRight = which === check.answer
                  const mark = !settled ? '' : isRight ? ' right' : which === pick ? ' missed' : ' rest'
                  return (
                    <button
                      key={which}
                      type="button"
                      className={`wg-check-choice${mark}`}
                      aria-pressed={which === pick}
                      aria-label={settled && isRight ? `${choice}, the right answer` : undefined}
                      // Settled, a choice says so rather than going dead, so the one you picked keeps focus.
                      aria-disabled={settled || undefined}
                      disabled={disabled}
                      onClick={() => {
                        if (!settled) onPick(picked.map((one, question) => (question === at ? which : one)))
                      }}
                    >
                      {settled && (isRight || which === pick) && (
                        <span className="wg-check-mark" aria-hidden="true">{isRight ? <Check size={14} strokeWidth={3} /> : <X size={14} strokeWidth={3} />}</span>
                      )}
                      <span>{choice}</span>
                    </button>
                  )
                })}
              </div>
              {settled && (
                <p className="wg-check-why" aria-live="polite">
                  <b>{pick === check.answer ? 'Right.' : 'Not quite.'}</b>
                  {check.why ? ` ${check.why}` : pick === check.answer ? '' : ` The answer is “${check.choices[check.answer]}”.`}
                </p>
              )}
            </li>
          )
        })}
      </ol>
      {done && (
        <button type="button" className="wg-quiz-again" disabled={disabled} onClick={() => onPick(spec.checks.map(() => null))}>Start again</button>
      )}
      {error && <p className="chat-failed" role="alert">{error}</p>}
    </section>
  )
}
