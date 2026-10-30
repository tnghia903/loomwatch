// What the frame (the dock down the side of every screen) shares with the screen inside it.
import { useSyncExternalStore } from 'react'

/** The dock's places, top to bottom. */
export type Place = 'home' | 'projects' | 'agents' | 'skills' | 'quests' | 'ask' | 'you'

/** Which place a page belongs to: a team's page is in Projects, Usage and Connections are in You. */
export function placeOf(pathname: string, search = ''): Place {
  if (pathname === '/') return new URLSearchParams(search).has('path') ? 'projects' : 'home'
  if (pathname === '/projects' || pathname.startsWith('/projects/')) return 'projects'
  if (pathname === '/agents' || pathname.startsWith('/agents/')) return 'agents'
  if (pathname === '/skills') return 'skills'
  if (pathname === '/quests') return 'quests'
  if (pathname === '/you' || pathname === '/usage' || pathname === '/connections') return 'you'
  return 'home'
}

// Ask opens where the screen keeps its panel (Home, a team, a room). A screen with none sends the
// person Home with Ask open, which is where Ask answers about everything.
let askToggles: (() => void)[] = []
const ASK_OPEN_KEY = 'loomwatch:ask:open'

/** A screen's own Ask panel: the dock's Ask toggles it while the screen is shown. */
export function registerAskToggle(toggle: () => void): () => void {
  askToggles = [...askToggles, toggle]
  publish()
  return () => { askToggles = askToggles.filter((one) => one !== toggle); publish() }
}

export function toggleAsk() {
  const latest = askToggles.at(-1)
  if (latest) { latest(); return }
  try { window.sessionStorage.setItem(ASK_OPEN_KEY, 'true') } catch { /* the panel opens anyway */ }
  window.location.assign('/')
}

/** Whether the screen has an Ask panel of its own, whether it is open, and what Ask is doing, for
    the dock's Ask to show. */
export interface AskShown { here: boolean; open: boolean; activity: string | null }
const ASK_CLOSED: AskShown = { here: false, open: false, activity: null }
let askShown = ASK_CLOSED
let askState = { open: false, activity: null as string | null }
const askWatchers = new Set<() => void>()
function publish() {
  const here = askToggles.length > 0
  if (here === askShown.here && askState.open === askShown.open && askState.activity === askShown.activity) return
  askShown = { here, ...askState }
  askWatchers.forEach((watch) => watch())
}

/** A screen with an Ask panel says how it is; it says closed when it goes. */
export function showAsk(next: { open: boolean; activity: string | null }) {
  askState = next
  publish()
}

export function useAskShown(): AskShown {
  return useSyncExternalStore(
    (changed) => { askWatchers.add(changed); return () => { askWatchers.delete(changed) } },
    () => askShown,
    () => ASK_CLOSED,
  )
}

// Labels that leave (round 3, rule 2): a place shows its name under its icon until it has been
// used this many times, then only on hover and to screen readers.
export const LABEL_USES = 5
const USES_KEY = 'loomwatch:dock:uses'

/** How many times each place has been used, by its name: the dock's places, and You's tabs. */
export function readUses(): Partial<Record<string, number>> {
  try { return JSON.parse(window.localStorage.getItem(USES_KEY) ?? '{}') as Partial<Record<string, number>> } catch { return {} }
}

export function countUse(place: string) {
  const uses = readUses()
  uses[place] = (uses[place] ?? 0) + 1
  try { window.localStorage.setItem(USES_KEY, JSON.stringify(uses)) } catch { /* a private window keeps its labels */ }
}
