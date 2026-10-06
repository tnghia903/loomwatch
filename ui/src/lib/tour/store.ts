import { useSyncExternalStore } from 'react'

import { currentRun } from './currentRun'
import { TOUR_STEPS, type TourStepId } from './steps'

/**
 * The getting-started guide's progress, kept per browser.
 *
 * It lives in `localStorage` because the guide spans full page loads: creating a team navigates to
 * it, so the step the operator was on has to survive the reload. Losing it (a private window,
 * cleared site data) only means the guide is not offered again on its own, never a broken screen.
 */
export interface TourState {
  status: 'active' | 'finished' | 'dismissed'
  step: TourStepId
  /**
   * The run on screen when the current step began. "Ask the team" waits for a run that is new
   * since then, so reopening an earlier run cannot count as the operator's first one.
   */
  runAtStepStart?: string | null
}

const STORAGE_KEY = 'loomwatch:tour'
const CHANGE_EVENT = 'loomwatch:tour-change'
const STEP_IDS = new Set<string>(TOUR_STEPS.map((step) => step.id))

let cached: { raw: string | null; state: TourState | null } | null = null
/** This page's answer when storage refused to keep it; `undefined` while storage works. */
let unstored: TourState | null | undefined

function read(): TourState | null {
  if (unstored !== undefined) return unstored
  let raw: string | null = null
  try { raw = localStorage.getItem(STORAGE_KEY) } catch { return null }
  if (cached && cached.raw === raw) return cached.state
  let state: TourState | null = null
  try {
    const parsed = raw ? JSON.parse(raw) as Partial<TourState> : null
    if (parsed && ['active', 'finished', 'dismissed'].includes(parsed.status ?? '') && STEP_IDS.has(parsed.step ?? '')) state = parsed as TourState
  } catch { /* an unreadable value is the same as none */ }
  cached = { raw, state }
  return state
}

function write(state: TourState | null) {
  const raw = state ? JSON.stringify(state) : null
  try {
    if (raw) localStorage.setItem(STORAGE_KEY, raw)
    else localStorage.removeItem(STORAGE_KEY)
    unstored = undefined
  } catch {
    // Storage refused: the guide still works on this page, it just won't resume after a reload.
    unstored = state
  }
  cached = { raw, state }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => { if (event.key === STORAGE_KEY) onChange() }
  window.addEventListener(CHANGE_EVENT, onChange)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener('storage', onStorage)
  }
}

export function useTourState(): TourState | null {
  return useSyncExternalStore(subscribe, read, () => null)
}

export function readTourState(): TourState | null {
  return read()
}



/** Start (or restart) the guide from its first card. The menu, ⌘K and Home's link all call this. */
export function startTour() {
  write({ status: 'active', step: TOUR_STEPS[0].id, runAtStepStart: currentRun() })
}

export function goToStep(step: TourStepId) {
  write({ status: 'active', step, runAtStepStart: currentRun() })
}

/** `finished` after the last card; `dismissed` when the operator closes it early. */
export function endTour(status: 'finished' | 'dismissed') {
  const state = read()
  write({ status, step: state?.step ?? TOUR_STEPS[0].id })
}

/**
 * Offer the guide to someone who has never seen it and has never run a team. Anyone who has finished
 * or closed it, or who has run something, is left alone: they can still open it from the menu or ⌘K.
 *
 * The teams folder alone cannot tell: `./loomwatch` creates it with an offline demo team in it, so a
 * newcomer always has one team. Run history can; when it cannot be read, an empty teams folder is
 * the best sign left.
 */
export async function offerTourIfFirstRun(teamCount: number, listRuns: () => Promise<readonly unknown[]>) {
  if (read()) return
  let neverRan: boolean
  try {
    neverRan = (await listRuns()).length === 0
  } catch {
    neverRan = teamCount === 0
  }
  if (neverRan && !read()) startTour()
}

/** Tests only. */
export function resetTourForTests() {
  cached = null
  unstored = undefined
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
}
