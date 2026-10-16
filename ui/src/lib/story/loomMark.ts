import { useEffect, useState, useSyncExternalStore } from 'react'

import { isTerminalRun, type RunRecord } from '../runs/client'

/**
 * What LoomWatch's own mark says, from what the needs-you poll already knows (useNeedsYou). Like
 * the crew's figures it moves only when the app has something true to say: it glances along the
 * work while a team runs, its mouth opens when something needs you, and it blinks once when a run
 * is done. Otherwise it is still.
 */
export type LoomMarkState = 'ready' | 'running' | 'asking' | 'finished'

export interface LoomMarkPose {
  /** The face glances slowly left and right, along the work. */
  glance: boolean
  /** The gold weft stitch, or a small gold "o" when something needs you. */
  mouth: 'stitch' | 'o'
  /** One blink, then rest. */
  blink: boolean
  /** The crew's colours: blue while a team works, gold when it is your turn (gold is you). */
  glow: 'none' | 'live' | 'you'
  /** Whether the glow breathes. Only work in progress does, as with the crew. */
  breathe: boolean
}

const POSES: Record<LoomMarkState, LoomMarkPose> = {
  ready: { glance: false, mouth: 'stitch', blink: false, glow: 'none', breathe: false },
  running: { glance: true, mouth: 'stitch', blink: false, glow: 'live', breathe: true },
  asking: { glance: false, mouth: 'o', blink: false, glow: 'you', breathe: false },
  finished: { glance: false, mouth: 'stitch', blink: true, glow: 'none', breathe: false },
}

/** Something waiting on you outranks a running team; a finished run only shows once all is quiet. */
export function loomMarkState({ waiting, working, finished }: { waiting: number; working: number; finished: boolean }): LoomMarkState {
  if (waiting > 0) return 'asking'
  if (working > 0) return 'running'
  return finished ? 'finished' : 'ready'
}

/**
 * The pose for a state. Reduced motion keeps what is not motion: the glow, held still, and the
 * mouth's shape, since shape is the first channel and colour is never the only one.
 */
export function loomMarkPose(state: LoomMarkState, { reducedMotion = false }: { reducedMotion?: boolean } = {}): LoomMarkPose {
  const pose = POSES[state] ?? POSES.ready
  return reducedMotion ? { ...pose, glance: false, blink: false, breathe: false } : pose
}

/** The mark's tooltip, when it is saying something that lasts long enough to hover. */
export const LOOM_MARK_SAYS: Record<LoomMarkState, string | null> = {
  ready: null,
  running: 'A team is working',
  asking: 'Something needs you',
  finished: null,
}

/** Runs that were under way in one poll and have ended by the next. */
export function runsJustFinished(before: readonly RunRecord[], after: readonly RunRecord[]): string[] {
  const live = new Set(before.filter((record) => !isTerminalRun(record.status)).map((record) => record.runId))
  return after.filter((record) => live.has(record.runId) && isTerminalRun(record.status)).map((record) => record.runId)
}

/** Long enough for the one blink to play out before the mark rests. */
export const FINISHED_FOR_MS = 1200

/**
 * The mark's state from the needs-you poll. "Finished" lasts one blink, and only counts a run seen
 * live in an earlier poll, so opening the app on yesterday's runs does not blink.
 */
export function useLoomMarkState(records: readonly RunRecord[], waiting: number, working: number): LoomMarkState {
  const [seen, setSeen] = useState(records)
  const [finished, setFinished] = useState(false)
  if (seen !== records) {
    setSeen(records)
    if (runsJustFinished(seen, records).length > 0) setFinished(true)
  }
  useEffect(() => {
    if (!finished) return
    const timer = setTimeout(() => setFinished(false), FINISHED_FOR_MS)
    return () => clearTimeout(timer)
  }, [finished])
  return loomMarkState({ waiting, working, finished })
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia?.(REDUCED_MOTION)
  query?.addEventListener('change', onChange)
  return () => query?.removeEventListener('change', onChange)
}

/** The operator's reduced-motion setting, kept current if they change it while LoomWatch is open. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, () => window.matchMedia?.(REDUCED_MOTION).matches ?? false, () => false)
}
