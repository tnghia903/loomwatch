import type { WidgetSpec } from './types'

type Quiz = Extract<WidgetSpec, { kind: 'quiz' }>

/** How many of a quiz's questions you answered, and how many of those are right. */
export function quizScore(spec: Quiz, picked: readonly (number | null)[]): { answered: number; right: number } {
  let answered = 0
  let right = 0
  spec.checks.forEach((check, at) => {
    const pick = picked[at]
    if (pick === null || pick === undefined) return
    answered += 1
    if (pick === check.answer) right += 1
  })
  return { answered, right }
}
