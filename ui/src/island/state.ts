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
import { ISLAND_WAITS } from './waits'

/** At a notch, every view; without one (decision 11), only the box (`box`), its agent at its
    workbench (`bench`) and tucked away at work after a message from it (`pill`), what that agent
    asks or answers, the slot, and `hidden`. */
export type IslandViewName = 'hidden' | 'rest' | 'tucked' | 'work' | 'ask' | 'done' | 'fail' | 'list' | 'slot' | 'box' | 'bench' | 'pill'

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
  /** This screen's panel is the live one, on the screen the pointer is on (always so in a browser,
      and until the app says): only it opens, and what the box's agent does drops out there. */
  live: boolean
  /** This island pops the teams' news out: the one at a notch (always so in a browser, and until
      the app says). Without a notch the menu bar face has it. */
  news: boolean
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
  /** The agent the box writes to: the pinned one, else the first of My agents, which a message
      from the box pins. `null` with no agents, when there is no box. */
  box: PinnedNow | null
  /** A message to it is being written: the list stays open, wherever the pointer goes, until it is
      sent, put away with Escape, or a click lands elsewhere. */
  composing: boolean
  /** Without a notch, after a message from the box: its agent's work shows in a pill until it
      answers, or a click lands elsewhere; pointing at the pill opens its workbench. */
  following: boolean
  /** The box's agent's workbench is open under it. */
  bench: boolean
  /** Without a notch, the pill is pointed at: its agent's workbench is open until the pointer
      leaves, as the list closes. Not the list: closing it sees nothing. */
  peeking: boolean
  /** After a message from the box, its agent's workbench shows on its own until then, so the
      person sees it start, and knows where to watch it; 0 when it doesn't. */
  benchUntil: number
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
  | { type: 'box'; box: PinnedNow | null }
  /** Writing to the box's agent begins, or ends. */
  | { type: 'compose'; on: boolean }
  /** A message went from the box: without a notch, its agent's work shows in a pill. */
  | { type: 'sent' }
  /** The pointer has rested on the pill: its agent's workbench opens. */
  | { type: 'peek' }
  /** The box's agent's workbench opens under the box, or folds away. */
  | { type: 'bench'; on: boolean }
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
    app: { placed: !inApp, notch: BROWSER_NOTCH, menuBar: BROWSER_NOTCH.height, away: false, fullScreen: false, drag: false, live: true, news: true },
    onIsland: false,
    onDrop: false,
    listOpen: false,
    pinned: null,
    box: null,
    composing: false,
    following: false,
    bench: false,
    peeking: false,
    benchUntil: 0,
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
      const moments = here(s, teams, momentsBetween(s.teams, teams))
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
      s = action.over ? pointedAt(s) : { ...s, onIsland: false }
      break
    case 'pointerOnDrop':
      s = { ...s, onDrop: action.over }
      break
    case 'closeList':
      s = s.onIsland || s.composing ? s : { ...seeResults({ ...s, listOpen: false }, (team) => s.app.notch !== null && (team.moment === 'done' || team.moment === 'fail')), peeking: false }
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
      s = { ...s, pinned: action.pinned }
      if (s.teams) {
        // What the pinned agent asks of you is news once the island knows whose it is.
        const teams = withPinned(teamsNow(s.records, s.since, s.seen, s.lastAgent, s.notes), s.pinned, s.requests, s.since, s.seen)
        const moments = here(s, teams, momentsBetween(s.teams, teams))
        s = { ...s, teams }
        if (moments.length) s = { ...s, pop: arrive(s.pop, moments, circumstances(s)) }
      }
      break
    case 'box':
      s = { ...s, box: action.box, composing: s.composing && action.box !== null, bench: s.bench && action.box !== null }
      break
    case 'compose':
      s = action.on && s.box ? openToWrite(s) : { ...s, composing: false }
      break
    case 'sent':
      // The box gives way to the agent's workbench, where it starts; without a notch it then tucks
      // into a pill while it works.
      s = { ...s, listOpen: false, composing: false, bench: false, peeking: false, following: s.app.notch === null, benchUntil: s.now + ISLAND_WAITS.bench }
      break
    case 'bench':
      s = { ...s, bench: action.on && s.box !== null }
      break
    case 'peek':
      s = { ...s, peeking: s.onIsland && s.following }
      break
    case 'dragOver':
      s = { ...s, dragOver: action.over && s.box !== null }
      break
    case 'drop':
      // What went in waits in the box, which takes the keyboard: a job is picked, or typed.
      s = s.box ? { ...openToWrite(s), dragOver: false, app: { ...s.app, drag: false }, intake: action.intake } : s
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
      if (message.area === 0) return { ...pointedAt(s), onDrop: false }
      return { ...s, onIsland: false, onDrop: true }
    case 'clickOutside':
      return { ...s, listOpen: false, composing: false, following: false, bench: false, peeking: false, benchUntil: 0, pop: tuckOnClick(s.pop, s.now) }
    case 'compose':
      // ⌃⌥Space opens the box; pressed again while it is open, it puts it away.
      if (!s.box) return s
      return s.composing ? { ...s, composing: false, listOpen: false, bench: false } : openToWrite(s)
    case 'drag':
      // The drag's own events say when it is over the island and when it drops; a drag let go of
      // elsewhere is cleared by the page (`useIsland`).
      return { ...s, app: { ...s.app, drag: message.near && s.box !== null } }
    case 'live': {
      if (message.on) return { ...s, app: { ...s.app, live: true } }
      // The pointer went to another screen: what was open here closes at once, as a list closes
      // once the pointer has left it, and what drops out drops out over there.
      const resting = { ...s, app: { ...s.app, live: false, drag: false }, onIsland: false, onDrop: false, listOpen: false, composing: false, following: false, bench: false, peeking: false, benchUntil: 0, dragOver: false }
      return s.listOpen ? seeResults(resting, (team) => team.moment === 'done' || team.moment === 'fail') : resting
    }
    case 'news':
      return { ...s, app: { ...s.app, news: message.on } }
    case 'seen':
      return markSeen(s, message.runs)
  }
}

/** Pointing at the notch opens the list, in place of whatever was out. Without a notch there is no
    list: the pointer resting on the agent in its pill opens its workbench (`peek`, a moment later,
    so passing over it opens nothing), until the pointer leaves, as the list closes. */
function pointedAt(s: IslandState): IslandState {
  if (s.app.notch === null) return { ...s, onIsland: true }
  return { ...s, onIsland: true, listOpen: true, pop: tuckNow(s.pop, s.now) }
}

/** The list opens, in place of whatever was out, to write to the box's agent. */
function openToWrite(s: IslandState): IslandState {
  return { ...s, listOpen: true, composing: true, following: false, peeking: false, benchUntil: 0, pop: tuckNow(s.pop, s.now) }
}

/**
 * What may pop out here: the teams' news only on the island that has it, at the notch; what the
 * pinned agent does (it is the box's agent once a message has gone) only where the pointer is,
 * notch or not.
 */
function here(s: IslandState, teams: readonly TeamNow[], moments: readonly Pop[]): Pop[] {
  const news = s.app.news && s.app.notch !== null
  return moments.filter((moment) => (teams.find((team) => team.runId === moment.runId)?.pinned ? s.app.live : news))
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
  // The box's agent answered, or stopped: what it says takes the pill's place, and is the end of it.
  const ended = team?.pinned && (pop.out?.pop.kind === 'done' || pop.out?.pop.kind === 'fail')
  return { ...s, pop, shown: pop.out && team ? { pop: pop.out.pop, team } : s.shown, following: s.following && !ended }
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
  if (!s.app.placed) return 'hidden'
  // Something dragged near opens the slot where the pointer is, whatever was out: the box's agent
  // takes what is dropped.
  if (s.app.live && s.box && (s.app.drag || s.dragOver)) return 'slot'
  if (s.app.notch === null) return boxView(s)
  const teams = s.teams ?? []
  const resting: IslandViewName = teams.length ? 'tucked' : 'rest'
  // Only the live island, where the pointer is, opens the list; what pops out has arrived only
  // where it may (`here`).
  if (s.listOpen) return s.app.live ? 'list' : resting
  if (s.app.live && s.benchUntil > s.now) return 'bench'
  return s.pop.out && s.shown ? POP_VIEW[s.pop.out.pop.kind] : resting
}

/**
 * Without a notch nothing is drawn but the box, on the screen the pointer is on, and, after a
 * message from it, what its agent does: at its workbench for a moment, then tucked away at work in
 * a pill, whose workbench opens while it is pointed at; then what it asks or answers. The teams'
 * news is at the notch, or with the menu bar face.
 */
function boxView(s: IslandState): IslandViewName {
  if (!s.app.live) return 'hidden'
  // Open, the box stays until it is sent, put away or left, as the list does: not only while its
  // field has the keyboard, which it loses as its message goes.
  if (s.listOpen) return 'box'
  if (s.benchUntil > s.now) return 'bench'
  const out = s.pop.out && s.shown?.team.pinned ? s.pop.out.pop.kind : null
  if (out === 'ask' || out === 'done' || out === 'fail') return POP_VIEW[out]
  if (s.following) return s.peeking ? 'bench' : 'pill'
  return 'hidden'
}
