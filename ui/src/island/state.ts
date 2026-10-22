// The island's state, and every change to it (ADR 0083). Pure: what the teams are doing, what the
// Mac app says, where the pointer is, and what is out below the notch, moved on by one action at a
// time. `useIsland` only reads the runs, keeps the timers and draws what this says.
import type { NoteAnswering } from '../lib/chat/client'
import type { RunRecord } from '../lib/runs/client'
import type { FromApp } from './bridge'
import { advance, arrive, next, NOTHING_OUT, tuckNow, tuckOnClick, type Circumstances, type PopState } from './popouts'
import { momentsBetween, teamsNow, type Pop, type PopKind, type TeamNow } from './teams'

export type IslandViewName = 'hidden' | 'rest' | 'tucked' | 'work' | 'ask' | 'done' | 'fail' | 'list'

/** In a browser, with no app to say: a 14-inch MacBook Pro's notch. */
export const BROWSER_NOTCH = { width: 185, height: 32 }

export interface AppSays {
  /** The app has said where the panel is (always so in a browser). */
  placed: boolean
  /** The camera housing's size, or `null` on a screen without one. */
  notch: { width: number; height: number } | null
  menuBar: number
  away: boolean
  fullScreen: boolean
}

export interface IslandState {
  now: number
  /** Runs that end after this are news. */
  since: number
  /** `null` until the first reading. */
  teams: TeamNow[] | null
  records: readonly RunRecord[]
  /** Messages the agents answer in the chat themselves: no run has them. */
  notes: readonly NoteAnswering[]
  /** Results you have looked at. */
  seen: ReadonlySet<string>
  /** Who last worked on each run, for the moments between turns. */
  lastAgent: ReadonlyMap<string, string>
  app: AppSays
  /** The pointer is on the island, or on what dropped out of it. */
  onIsland: boolean
  onDrop: boolean
  listOpen: boolean
  pop: PopState
  /** What is out, or was last out: kept while it tucks away, so it can be drawn leaving. */
  shown: { pop: Pop; team: TeamNow } | null
}

export type IslandAction =
  /** What the teams are doing. Without `notes` (they could not be read this time), the island
      keeps those it last knew. */
  | { type: 'runs'; records: readonly RunRecord[]; notes?: readonly NoteAnswering[] | null }
  | { type: 'app'; message: FromApp }
  | { type: 'tick' }
  | { type: 'pointerOnIsland'; over: boolean }
  | { type: 'pointerOnDrop'; over: boolean }
  | { type: 'closeList' }
  /** A run opened in `LoomWatch`: its result is seen. */
  | { type: 'opened'; runId: string }
  /** A question answered from the island: the next one drops at once. */
  | { type: 'answered'; ticket: string }

export function initialIsland(now: number, inApp: boolean): IslandState {
  return {
    now,
    since: now,
    teams: null,
    records: [],
    notes: [],
    seen: new Set(),
    lastAgent: new Map(),
    app: { placed: !inApp, notch: BROWSER_NOTCH, menuBar: BROWSER_NOTCH.height, away: false, fullScreen: false },
    onIsland: false,
    onDrop: false,
    listOpen: false,
    pop: NOTHING_OUT,
    shown: null,
  }
}

/** Every action comes with the time it happened. */
export function islandReducer(state: IslandState, action: IslandAction & { now: number }): IslandState {
  let s: IslandState = { ...state, now: action.now }
  switch (action.type) {
    case 'runs': {
      const lastAgent = new Map(s.lastAgent)
      for (const record of action.records) if (record.working?.[0]) lastAgent.set(record.runId, record.working[0])
      const notes = action.notes ?? s.notes
      const teams = teamsNow(action.records, s.since, s.seen, lastAgent, notes)
      const moments = momentsBetween(s.teams, teams)
      s = { ...s, records: action.records, notes, lastAgent, teams }
      if (moments.length) s = { ...s, pop: arrive(s.pop, moments, circumstances(s)) }
      break
    }
    case 'app':
      s = fromApp(s, action.message)
      break
    case 'tick':
      break
    case 'pointerOnIsland':
      // Pointing at the island opens the list, in place of whatever was out.
      s = action.over ? { ...s, onIsland: true, listOpen: true, pop: tuckNow(s.pop, s.now) } : { ...s, onIsland: false }
      break
    case 'pointerOnDrop':
      s = { ...s, onDrop: action.over }
      break
    case 'closeList':
      s = s.onIsland ? s : seeResults({ ...s, listOpen: false }, (team) => team.moment === 'done' || team.moment === 'fail')
      break
    case 'opened':
      s = seeResults({ ...s, listOpen: false, pop: tuckNow(s.pop, s.now) }, (team) => team.runId === action.runId)
      break
    case 'answered': {
      const waiting = (s.teams ?? []).flatMap((team) => team.asks.filter((ask) => ask.id !== action.ticket).map((ask) => ({ runId: team.runId, key: ask.id })))
      const cleared = { ...tuckNow(s.pop, s.now), calmUntil: 0 }
      s = { ...s, pop: waiting[0] ? next(cleared, { kind: 'ask', ...waiting[0] }) : cleared }
      break
    }
  }
  return settle(s)
}

function fromApp(s: IslandState, message: FromApp): IslandState {
  switch (message.kind) {
    case 'place':
      return { ...s, app: { ...s.app, placed: true, notch: message.notch, menuBar: message.menuBar } }
    case 'away':
      return { ...s, app: { ...s.app, away: message.away } }
    case 'fullScreen':
      return { ...s, app: { ...s.app, fullScreen: message.on } }
    case 'pointer':
      // The island itself opens the list; a question or a slip stays out while the pointer is on
      // it. Off them all, the panel lets the pointer through again.
      if (!message.over || message.area === null) return { ...s, onIsland: false, onDrop: false }
      if (message.area === 0) return { ...s, onIsland: true, onDrop: false, listOpen: true, pop: tuckNow(s.pop, s.now) }
      return { ...s, onIsland: false, onDrop: true }
    case 'clickOutside':
      return { ...s, listOpen: false, pop: tuckOnClick(s.pop, s.now) }
  }
}

/** Results matching `which` have been seen: they leave the island. */
function seeResults(s: IslandState, which: (team: TeamNow) => boolean): IslandState {
  const results = (s.teams ?? []).filter((team) => (team.moment === 'done' || team.moment === 'fail') && which(team)).map((team) => team.runId)
  if (!results.length) return s
  const seen = new Set([...s.seen, ...results])
  return { ...s, seen, teams: teamsNow(s.records, s.since, seen, s.lastAgent, s.notes) }
}

/** Tuck away, hold and bring out, as the time and the circumstances say; remember what is out. */
function settle(s: IslandState): IslandState {
  const teams = s.teams ?? []
  const pop = advance(s.pop, circumstances(s), (candidate) => valid(candidate, teams))
  const team = pop.out ? teams.find((each) => each.runId === pop.out!.pop.runId) : undefined
  return { ...s, pop, shown: pop.out && team ? { pop: pop.out.pop, team } : s.shown }
}

function circumstances(s: IslandState): Circumstances {
  return {
    now: s.now,
    away: s.app.away,
    fullScreen: s.app.fullScreen,
    teamsAtWork: (s.teams ?? []).filter((team) => team.moment === 'work').length,
    notch: s.app.notch !== null,
    pointer: s.onDrop,
  }
}

/** Still worth showing: the question still waits, the result is still news, the team still works. */
function valid(candidate: Pop, teams: readonly TeamNow[]): boolean {
  const team = teams.find((each) => each.runId === candidate.runId)
  if (!team) return false
  if (candidate.kind === 'ask') return team.asks.some((ask) => ask.id === candidate.key)
  if (candidate.kind === 'done' || candidate.kind === 'fail') return team.moment === candidate.kind
  return team.moment === 'work'
}

const POP_VIEW: Record<PopKind, IslandViewName> = { start: 'work', handover: 'work', ask: 'ask', done: 'done', fail: 'fail' }

/** What the island draws now. */
export function viewOf(s: IslandState): IslandViewName {
  const teams = s.teams ?? []
  let view: IslandViewName = s.listOpen ? 'list' : s.pop.out && s.shown ? POP_VIEW[s.pop.out.pop.kind] : teams.length ? 'tucked' : 'rest'
  // Without a notch the island is there only while a question or a result has dropped.
  if (!s.app.placed || (s.app.notch === null && !s.listOpen && (view === 'rest' || view === 'tucked' || view === 'work'))) view = 'hidden'
  return view
}
