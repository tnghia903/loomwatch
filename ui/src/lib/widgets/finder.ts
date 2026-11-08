import type { WidgetAnswer, WidgetOutcome, WidgetQuestion, WidgetSpec } from './types'

type Finder = Extract<WidgetSpec, { kind: 'finder' }>

/** One question on your path and the answer you took there (`picked`, from 0). */
export interface FinderStep { question: WidgetQuestion; at: number; answer: WidgetAnswer; picked: number }

/** Where you are in a finder: what you answered, then the question waiting on you or, at the end
    of your path, its outcome. */
export interface FinderWalk {
  path: FinderStep[]
  asking: { question: WidgetQuestion; at: number } | null
  outcome: WidgetOutcome | null
}

/**
 * Your path through a finder (ADR 0114, amended 8 November) from the answer you took at each
 * question, as the daemon's `finder::walk` reads it: from the first question, each answer leading to
 * a later question or to an outcome. An answer that doesn't follow ends the path there, so a kept
 * path from an older finder never breaks it.
 */
export function walkFinder(spec: Finder, taken: readonly number[]): FinderWalk {
  const path: FinderStep[] = []
  let at = 0
  for (const picked of taken) {
    const question = spec.questions[at]
    const answer = question?.answers[picked]
    if (!question || !answer) break
    path.push({ question, at, answer, picked })
    if (answer.outcome !== undefined) {
      const outcome = spec.outcomes[answer.outcome - 1]
      if (outcome) return { path, asking: null, outcome }
      path.pop()
      break
    }
    if (answer.next === undefined || !spec.questions[answer.next - 1]) {
      path.pop()
      break
    }
    at = answer.next - 1
  }
  const question = spec.questions[at]
  return { path, asking: question ? { question, at } : null, outcome: null }
}
