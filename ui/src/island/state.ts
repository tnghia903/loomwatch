// The island's state, and every change to it (ADR 0083). Pure: what the teams are doing, what the
// Mac app says, where the pointer is, and what is out below the notch, moved on by one action at a
// time. `useIsland` only reads the runs, keeps the timers and draws what this says.
import type { NoteAnswering } from '../lib/chat/client'
import type { RunRecord } from '../lib/runs/client'
import type { FromApp } from './bridge'
import { withPinned, type PinnedNow } from './pinned'
import { advance, arrive, next, NOTHING_OUT, tuckNow, tuckOnClick, type Circumstances, type PopState } from './popouts'
import type { TeamRequest } from '../lib/runs/teamRequests'
import type { Intake } from './intake'
import { momentsBetween, teamAskKey, teamsNow, type Pop, type PopKind, type TeamNow } from './teams'

export type IslandViewName = 'hidden' | 'rest' | 'tucked' | 'work' | 'ask' | 'done' | 'fail' | 'list' | 'slot'

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
  /** Something is being dragged near the island, in another app. */
  drag: boolean
  /** This screen's island is the live one, on the screen the pointer is on (always so in a
      browser, and until the app says): only it opens and drops things out. */
  live: boolean
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
  /** The pinned agent's requests for your teams (ADR 0083, decision 10). */
  requests: readonly TeamRequest[]
  /** Results you have looked at. */
  seen: ReadonlySet<string>
  /** Who last worked on each run, for the moments between turns. */
  lastAgent: ReadonlyMap<string, string>
  app: AppSays
  /** The pointer is on the island, or on what dropped out of it. */
  onIsland: boolean
  onDrop: boolean
  listOpen: boolean
  /** The agent pinned to the notch, while it is one of My agents. */
  pinned: PinnedNow | null
  /** A message to it is being written: the list stays open, wherever the pointer goes, until it is
      sent, put away with Escape, or a click lands elsewhere. */
  composing: boolean
  /** Something dragged onto the page itself is over the island. */
  dragOver: boolean
  /** What was dropped into the slot, waiting for a job. */
  intake: Intake | null
  pop: PopState
  /** What is out, or was last out: kept while it tucks away, so it can be drawn leaving. */
  shown: { pop: Pop; team: TeamNow } | null
}

export type IslandAction =
  /** What the teams are doing. Without `notes` (they could not be read this time), the island
      keeps those it last knew. */
  | { type: 'runs'; records: readonly RunRecord[]; notes?: readonly NoteAnswering[] | null; requests?: readonly TeamRequest[] | null }
  | { type: 'app'; message: FromApp }
  | { type: 'tick' }
  | { type: 'pointerOnIsland'; over: boolean }
  | { type: 'pointerOnDrop'; over: boolean }
  | { type: 'closeList' }
  /** A run opened in `LoomWatch`: its result is seen. */
  | { type: 'opened'; runId: string }
  /** A question answered from the island: the next one drops at once. */
  | { type: 'answered'; ticket: string }
  | { type: 'pinned'; pinned: PinnedNow | null }
  /** Writing to the pinned agent begins, or ends. */
  | { type: 'compose'; on: boolean }
  /** A drag on the page itself enters the island, or leaves it. */
  | { type: 'dragOver'; over: boolean }
  /** Something was dropped into the slot: it waits in the box for a job. */
  | { type: 'drop'; intake: Intake }
  /** What was dropped went with a message, or was put away. */
  | { type: 'intakeDone' }

export function initialIsland(now: number, inApp: boolean): IslandState {
  return {
    now,
    since: now,
    teams: null,
    records: [],
    notes: [],
    requests: [],
    seen: new Set(),
    lastAgent: new Map(),
    app: { placed: !inApp, notch: BROWSER_NOTCH, menuBar: BROWSER_NOTCH.height, away: false, fullScreen: false, drag: false, live: true },
    onIsland: false,
    onDrop: false,
    listOpen: false,
    pinned: null,
    composing: false,
    dragOver: false,
    intake: null,
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
      const requests = action.requests ?? s.requests
      const teams = withPinned(teamsNow(action.records, s.since, s.seen, lastAgent, notes), s.pinned, requests, s.since, s.seen)
      const moments = momentsBetween(s.teams, teams)
      s = { ...s, records: action.records, notes, requests, lastAgent, teams }
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
      s = s.onIsland || s.composing ? s : seeResults({ ...s, listOpen: false }, (team) => team.moment === 'done' || team.moment === 'fail')
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
    case 'pinned':
      s = { ...s, pinned: action.pinned, composing: s.composing && action.pinned !== null }
      if (s.teams) {
        // What the pinned agent asks of you is news once the island knows whose it is.
        const teams = withPinned(teamsNow(s.records, s.since, s.seen, s.lastAgent, s.notes), s.pinned, s.requests, s.since, s.seen)
        const moments = momentsBetween(s.teams, teams)
        s = { ...s, teams }
        if (moments.length) s = { ...s, pop: arrive(s.pop, moments, circumstances(s)) }
      }
      break
    case 'compose':
      s = action.on && s.pinned ? openToWrite(s) : { ...s, composing: false }
      break
    case 'dragOver':
      s = { ...s, dragOver: action.over && s.pinned !== null }
      break
    case 'drop':
      // What went in waits in the box, which takes the keyboard: a job is picked, or typed.
      s = s.pinned ? { ...openToWrite(s), dragOver: false, app: { ...s.app, drag: false }, intake: action.intake } : s
      break
    case 'intakeDone':
      s = { ...s, intake: null }
      break
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
      return { ...s, listOpen: false, composing: false, pop: tuckOnClick(s.pop, s.now) }
    case 'compose':
      // ⌃⌥Space opens the box; pressed again while it is open, it puts it away.
      if (!s.pinned) return s
      return s.composing ? { ...s, composing: false, listOpen: false } : openToWrite(s)
    case 'drag':
      // The drag's own events say when it is over the island and when it drops; a drag let go of
      // elsewhere is cleared by the page (`useIsland`).
      return { ...s, app: { ...s.app, drag: message.near && s.pinned !== null } }
    case 'live': {
      if (message.on) return { ...s, app: { ...s.app, live: true } }
      // The pointer went to another screen: what was open here closes at once, as a list closes
      // once the pointer has left it, and what drops out drops out over there.
      const resting = { ...s, app: { ...s.app, live: false, drag: false }, onIsland: false, onDrop: false, listOpen: false, composing: false, dragOver: false }
      return s.listOpen ? seeResults(resting, (team) => team.moment === 'done' || team.moment === 'fail') : resting
    }
    case 'seen':
      return markSeen(s, message.runs)
  }
}

/** The list opens, in place of whatever was out, to write to the pinned agent. */
function openToWrite(s: IslandState): IslandState {
  return { ...s, listOpen: true, composing: true, pop: tuckNow(s.pop, s.now) }
}

/** Results matching `which` have been seen: they leave the island. */
function seeResults(s: IslandState, which: (team: TeamNow) => boolean): IslandState {
  return markSeen(s, (s.teams ?? []).filter((team) => (team.moment === 'done' || team.moment === 'fail') && which(team)).map((team) => team.runId))
}

/** These runs' results have been seen, here or on another screen's island: they leave it. */
function markSeen(s: IslandState, runs: readonly string[]): IslandState {
  const fresh = runs.filter((run) => !s.seen.has(run))
  if (!fresh.length) return s
  const seen = new Set([...s.seen, ...fresh])
  return { ...s, seen, teams: withPinned(teamsNow(s.records, s.since, seen, s.lastAgent, s.notes), s.pinned, s.requests, s.since, seen) }
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
    pointer: s.onDrop,
  }
}

/** Still worth showing: the question still waits, the result is still news, the team still works. */
function valid(candidate: Pop, teams: readonly TeamNow[]): boolean {
  const team = teams.find((each) => each.runId === candidate.runId)
  if (!team) return false
  if (candidate.kind === 'ask') return team.asks.some((ask) => ask.id === candidate.key) || (team.teamAsks ?? []).some((ask) => teamAskKey(ask) === candidate.key)
  if (candidate.kind === 'done' || candidate.kind === 'fail') return team.moment === candidate.kind
  return team.moment === 'work'
}

const POP_VIEW: Record<PopKind, IslandViewName> = { start: 'work', handover: 'work', ask: 'ask', done: 'done', fail: 'fail' }

/** What the island draws now. */
export function viewOf(s: IslandState): IslandViewName {
  const teams = s.teams ?? []
  // Something dragged near opens the slot, whatever was out: the pinned agent takes what is dropped.
  if (s.app.placed && s.app.live && s.pinned && (s.app.drag || s.dragOver)) return 'slot'
  let view: IslandViewName = s.listOpen ? 'list' : s.pop.out && s.shown ? POP_VIEW[s.pop.out.pop.kind] : teams.length ? 'tucked' : 'rest'
  // Every screen has an island; only the live one, where the pointer is, shows what drops out.
  if (!s.app.live) view = teams.length ? 'tucked' : 'rest'
  // On a screen without a notch the island rests at the middle of the menu bar, as at a notch;
  // over a full-screen app there it is there only while something has dropped out of it.
  if (!s.app.placed || (s.app.notch === null && s.app.fullScreen && !s.listOpen && (view === 'rest' || view === 'tucked' || view === 'work'))) view = 'hidden'
  return view
}
