import type { WidgetGuess, WidgetPart } from './types'

/**
 * How a picture plays (ADR 0117, amended 7 November), by what learning research says of pictures
 * that move: slow enough to see each change, a pause on every step long enough to read its words,
 * the first longer so the parts are named before anything moves, and the step a guess comes before
 * longer still, so what was guessed can be read with it.
 *
 * Its words are read at an adult's average silent reading pace, about 238 words a minute (Brysbaert
 * 2019), some 45 ms a character, with half a second to look at what changed: a fixed 2 s on every
 * step and 1.8 s moves had a three-step picture of short steps take 18 s, and people waited on it.
 */
export const MOVE_MS = 1200
const REST_LEAST_MS = 1500
const REST_BASE_MS = 500
const REST_PER_CHAR_MS = 45
const REST_MOST_MS = 8000
const NAMES_FIRST_MS = 500
const GUESSED_MS = 1500

/** One stretch of a play: resting on a step (`from` equals `to`) or moving to the next, from
    `start` ms into the play. */
export interface Stretch { from: number; to: number; ms: number; start: number }

/** How long a step rests: long enough to read its words. */
export function restFor(part: WidgetPart, step: number, guess?: WidgetGuess): number {
  const reading = Math.min(REST_MOST_MS, Math.max(REST_LEAST_MS, REST_BASE_MS + REST_PER_CHAR_MS * [...part.text].length))
  return reading + (step === 0 ? NAMES_FIRST_MS : 0) + (guess && step === guess.before - 1 ? GUESSED_MS : 0)
}

/** The whole play: a rest on each step and a move between each two. */
export function stretches(parts: readonly WidgetPart[], guess?: WidgetGuess): Stretch[] {
  const out: Stretch[] = []
  let start = 0
  const add = (from: number, to: number, ms: number) => { out.push({ from, to, ms, start }); start += ms }
  parts.forEach((part, step) => {
    add(step, step, restFor(part, step, guess))
    if (step < parts.length - 1) add(step, step + 1, MOVE_MS)
  })
  return out
}

export const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2)
const tenth = (value: number) => Math.round(value * 10) / 10

/** The daemon's path data (`M10 20L30 40C…Z`) with its numbers apart from its commands, so one
    stage's drawing can move into the next's, point by point. */
export interface Parsed { commands: string[]; numbers: number[][] }
export function parsed(d: string): Parsed {
  const commands: string[] = []
  const numbers: number[][] = []
  for (const [, command, rest] of d.matchAll(/([MLCZ])([^MLCZ]*)/g)) {
    commands.push(command)
    numbers.push(rest.trim() ? rest.trim().split(/\s+/).map(Number) : [])
  }
  return { commands, numbers }
}

/** `u` of the way from one drawing to the other. */
export function between(from: Parsed, to: Parsed, u: number): string {
  return from.commands.map((command, i) => command + from.numbers[i].map((value, j) => tenth(value + ((to.numbers[i]?.[j] ?? value) - value) * u)).join(' ')).join('')
}

/** Where a moving thing is at `t` steps: between stages `at` and `at + 1`, `u` of the way, eased.
    A stage stands at its part's step. */
export function whereIn(stages: readonly { part: number }[], t: number): { at: number; u: number } {
  for (let at = 0; at < stages.length - 1; at++) {
    const from = stages[at].part - 1
    const to = stages[at + 1].part - 1
    if (t <= from) return { at, u: 0 }
    if (t <= to) return { at, u: ease((t - from) / Math.max(1e-6, to - from)) }
  }
  return { at: stages.length - 2, u: 1 }
}

/** A play in this window, by the picture it plays: the kept picture that takes the place of the
    one drawn while the answer was written carries on where that one was, and a picture plays and
    asks its question once. */
export interface Play {
  /** When the play began, on `performance.now()`'s clock, as if it had never stopped. */
  start: number
  /** Its question has been asked. */
  asked: boolean
  /** Waiting on its question: how far into the play it goes on from, and the step it waits on. */
  waiting: { ms: number; step: number } | null
  /** What the person guessed, said on the step the question comes before. */
  note: string | null
  /** Played through, or stopped by the person: a picture drawn again rests. */
  done: boolean
}
export const plays = new Map<string, Play>()

/** A dial's values (ADR 0117, amended 7 November): when every step's label is a number with the
    same words around it ("0 km/h", "Round 3", "Day 15"), the number and those words. */
export interface DialScale { values: number[]; before: string; after: string; decimals: number }
export function dialScale(parts: readonly WidgetPart[]): DialScale | null {
  const read = parts.map((part) => part.label.match(/^(\D*?)(-?\d+(?:\.\d+)?)(\D*)$/))
  if (read.length < 2 || read.some((one) => !one)) return null
  const [first] = read as RegExpMatchArray[]
  if ((read as RegExpMatchArray[]).some((one) => one[1] !== first[1] || one[3] !== first[3])) return null
  return {
    values: (read as RegExpMatchArray[]).map((one) => Number(one[2])),
    before: first[1],
    after: first[3],
    decimals: Math.max(...(read as RegExpMatchArray[]).map((one) => one[2].split('.')[1]?.length ?? 0)),
  }
}

/** What the dial reads at `t` steps: the value between two steps' values as the drawing is between
    them, when the labels are numbers; otherwise the nearest step's label. */
export function dialReading(parts: readonly WidgetPart[], t: number): string {
  const scale = dialScale(parts)
  const at = Math.min(Math.max(t, 0), parts.length - 1)
  if (!scale) return parts[Math.round(at)]?.label ?? ''
  const from = Math.min(Math.floor(at), parts.length - 2)
  const value = scale.values[from] + (scale.values[from + 1] - scale.values[from]) * ease(at - from)
  const written = value.toFixed(scale.decimals).replace(/^-0(\.0+)?$/, '0$1')
  return `${scale.before}${written}${scale.after}`
}
