// What a person's message said done looks like (ADR 0098): LoomWatch reads it while the work runs,
// shows it under the message, and the work is checked against it before it becomes the answer.
// The daemon records each change as a `done_when` session_meta (crates/…/message_done.rs).

import { makerOf } from '../ai/makers'
import { modelNameFromId } from '../ai/modelIds'

export interface DoneWhen {
  /** `found`: what was read; `failed`: the read failed, so the work isn't checked against it. */
  state: 'found' | 'failed'
  /** The message's own words, each with whether it is still checked. */
  items: { text: string; checked: boolean }[]
  /** How many tries the message gave the work, when it named a number. */
  tries: number | null
  /** How many times the work may go back for it, once the check knows. */
  rounds: number | null
  /** The model LoomWatch's own check runs on, and whether its maker is the checked agent's. */
  checker: { model: string; sameMaker: boolean } | null
  /** The check has ended: nothing can be taken off or put back. */
  ended: boolean
}

/** A `done_when` record as the chat shows it; `null` for anything else. */
export function readDoneWhen(payload: Record<string, unknown>): DoneWhen | null {
  if (payload.phase !== 'done_when') return null
  const state = payload.state
  if (state !== 'found' && state !== 'failed') return null
  const items = Array.isArray(payload.items)
    ? payload.items.flatMap((item: unknown) => {
      if (typeof item !== 'object' || item === null) return []
      const { text, checked } = item as { text?: unknown; checked?: unknown }
      return typeof text === 'string' ? [{ text, checked: checked !== false }] : []
    })
    : []
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  const checker = typeof payload.checker === 'object' && payload.checker !== null ? payload.checker as { model?: unknown; sameMaker?: unknown } : null
  return {
    state,
    items,
    tries: number(payload.tries),
    rounds: number(payload.rounds),
    checker: checker && typeof checker.model === 'string' ? { model: checker.model, sameMaker: checker.sameMaker === true } : null,
    ended: payload.ended === true,
  }
}

/**
 * How many tries the work has, counted as the person counts them, the first work one: the number
 * the run will use once its check knows it, else the one the message named. `null` when it named
 * none.
 */
export function triesShown(done: DoneWhen): number | null {
  if (done.tries === null) return null
  return done.rounds === null ? done.tries : done.rounds + 1
}

/** Who checks the work, said on hover: the model and its maker, and when it is the agent's own. */
export function checkerWords(done: DoneWhen): string | null {
  if (!done.checker) return null
  const maker = makerOf(done.checker.model).name
  const same = done.checker.sameMaker ? ', the same maker as the agent' : ''
  return `Checked on ${modelNameFromId(done.checker.model)}, by ${maker}${same}.`
}
