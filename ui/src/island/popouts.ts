// When something pops out below the notch and when it tucks away again (ADR 0083). Pure: the island
// hands it what happened and what time it is, and draws whatever it says is out.
import type { Pop, PopKind } from './teams'
import { ISLAND_WAITS } from './waits'

export interface Out {
  pop: Pop
  /** When it tucks away; `null` while it is held out. */
  until: number | null
  /** Why it is held: the pointer is on it, or the person is away from the Mac. */
  held: 'pointer' | 'away' | null
  /** When it came out. */
  since: number
}

export interface PopState {
  out: Out | null
  /** What pops out next, in turn. */
  queue: Pop[]
  /** Nothing new drops before this, so one pop-out does not land on the last one's heels. */
  calmUntil: number
}

export const NOTHING_OUT: PopState = { out: null, queue: [], calmUntil: 0 }

/** What the island knows of the person and the screen. */
export interface Circumstances {
  now: number
  /** No mouse or keyboard for a minute. */
  away: boolean
  /** An app is full screen: only questions and stops pop out. */
  fullScreen: boolean
  /** Teams at work right now: with more than one, starts and handovers stay tucked. */
  teamsAtWork: number
  /** The screen has a notch. Without one, only questions and results drop. */
  notch: boolean
  /** The pointer is on what is out. */
  pointer: boolean
}

/** A question or a stop first, then a result, then a start or a handover. */
const RANK: Record<PopKind, number> = { ask: 0, fail: 0, done: 1, start: 2, handover: 2 }

function wait(kind: PopKind): number {
  if (kind === 'ask') return ISLAND_WAITS.ask
  if (kind === 'done' || kind === 'fail') return ISLAND_WAITS.result
  return ISLAND_WAITS.start
}

/** Whether `pop` may pop out at all, here and now. */
export function pops(pop: Pop, c: Circumstances): boolean {
  if (pop.kind === 'start' || pop.kind === 'handover') return c.notch && !c.fullScreen && c.teamsAtWork <= 1
  if (pop.kind === 'done') return !c.fullScreen
  return true
}

/** New moments arrive. A start or a handover gives way at once to anything else; everything else
    waits its turn. */
export function arrive(state: PopState, arriving: readonly Pop[], c: Circumstances): PopState {
  let { out, queue } = state
  for (const pop of arriving) {
    if (!pops(pop, c)) continue
    if (out && same(out.pop, pop)) continue
    const quiet = out && (out.pop.kind === 'start' || out.pop.kind === 'handover')
    if (quiet && (RANK[pop.kind] < RANK[out!.pop.kind] || out!.pop.runId === pop.runId)) {
      out = null
      queue = [pop, ...queue.filter((waiting) => !same(waiting, pop))]
      continue
    }
    if (!queue.some((waiting) => same(waiting, pop))) queue = [...queue, pop].sort((a, b) => RANK[a.kind] - RANK[b.kind])
  }
  return { ...state, out, queue }
}

/** Put `pop` out next, ahead of everything: the next question once one is answered. */
export function next(state: PopState, pop: Pop): PopState {
  return { ...state, queue: [pop, ...state.queue.filter((waiting) => !same(waiting, pop))] }
}

/**
 * The time is `c.now`: tuck away what is due, hold what the pointer is on or what the person, away,
 * has not seen yet, and bring out the next. `valid` says whether a pop is still worth showing: a
 * question answered elsewhere, or a run that moved on, is not.
 */
export function advance(state: PopState, c: Circumstances, valid: (pop: Pop) => boolean): PopState {
  let { out, queue, calmUntil } = state
  if (out && (!valid(out.pop) || (out.until !== null && c.now >= out.until))) {
    out = null
    calmUntil = c.now + ISLAND_WAITS.between
  }
  if (out) out = hold(out, c)
  if (!out && c.now >= calmUntil) {
    queue = queue.filter((pop) => valid(pop) && pops(pop, c))
    const [first, ...rest] = queue
    if (first) {
      out = hold({ pop: first, until: c.now + wait(first.kind), held: null, since: c.now }, c)
      queue = rest
    }
  }
  return { out, queue, calmUntil }
}

function hold(out: Out, c: Circumstances): Out {
  if (c.pointer) return { ...out, until: null, held: 'pointer' }
  if (c.away) return out.held === 'away' ? out : { ...out, until: null, held: 'away' }
  // Let go: the pointer left (a short wait), or the person came back (the whole wait, from now).
  if (out.held === 'pointer') return { ...out, until: c.now + ISLAND_WAITS.afterPointer, held: null }
  if (out.held === 'away') return { ...out, until: c.now + wait(out.pop.kind), held: null }
  return out
}

/** What is out tucks away now: the list took its place, or it was answered or opened. */
export function tuckNow(state: PopState, now: number): PopState {
  return state.out ? { ...state, out: null, calmUntil: now + ISLAND_WAITS.between } : state
}

/** A click elsewhere: what is out tucks away, unless it has only just come out. */
export function tuckOnClick(state: PopState, now: number): PopState {
  return state.out && now - state.out.since < ISLAND_WAITS.clickGrace ? state : tuckNow(state, now)
}

/** When the island next needs to look at the time, if it does. */
export function wakesAt(state: PopState): number | null {
  if (state.out) return state.out.until
  return state.queue.length ? state.calmUntil : null
}

function same(a: Pop, b: Pop): boolean {
  return a.kind === b.kind && a.runId === b.runId && a.key === b.key
}
