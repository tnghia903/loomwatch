import { parse } from 'yaml'

import { isOpenTeam } from '../library/uses'
import { isTerminalRun, type RunRecord } from '../runs/client'
import { scheduleWords } from '../story/teamSentence'
import { pipelineOrder } from '../team-file/pipelineOrder'
import type { AgentConfig, TeamDocument } from '../team-file/types'
import { PRESENCE_WORDS, type Presence } from '../rail/presence'
import type { ProjectEntry } from './client'

/**
 * Home is a studio (ADR 0097): each project a room, its agents at desks in team order, and what
 * waits for you at Your desk. This is what the studio draws, worked out from the projects, their
 * teams' files and the runs, so the components only lay it out.
 */

/** A desk in a team's row: one of its agents, or a review stop, where you check. */
export interface SeatSpec {
  kind: 'agent' | 'you'
  id: string
  name: string
  /** The agent in My agents it is, which its figure and where-it-is follow. */
  agent?: string
}

/** A team as the studio reads it from its file: name, desks in the order work moves, schedule. */
export interface TeamShape {
  path: string
  name: string
  project: string | null
  seats: SeatSpec[]
  /** "Every day at 8:00 AM", when it runs on a schedule. */
  schedule: string | null
}

/** A desk as drawn now: who is at it, or where they are instead. */
export interface Seat extends SeatSpec {
  state: Presence
  /** Where the agent is instead of this desk: the team it is working in, or waiting for you in. */
  away: string | null
}

export interface RoomTeam {
  path: string
  name: string
  seats: Seat[]
  state: Presence
  schedule: string | null
}

export interface Room {
  id: string
  name: string
  mark?: string
  putAway: boolean
  teams: RoomTeam[]
  state: Presence
  /** One line of words saying what is happening: "Designer is working". */
  line: string
  /** When work last ended or started here, for ranking and for a quiet project's tile. */
  lastWorked: string | null
}

/** The order and the desks of a team file; `null` when it isn't a team. */
export function teamShapeOf(path: string, yaml: string, jobs: readonly { id: string; name: string }[] = []): TeamShape | null {
  let doc: Partial<TeamDocument> | null
  try { doc = parse(yaml) as Partial<TeamDocument> | null } catch { return null }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.agents)) return null
  const agents = doc.agents.filter((agent): agent is AgentConfig => Boolean(agent?.id))
  const ids = agents.map((agent) => agent.id)
  const edges = Array.isArray(doc.edges) ? doc.edges.filter((edge) => edge.layer !== 'observed') : []
  // A pipeline's desks stand in the order work moves; a lead and its teammates, lead first.
  const ordered = pipelineOrder(ids, edges, doc.entrypoint ?? null).map((step) => step.id)
  const order = ordered.length > 0 ? ordered : [...(doc.entrypoint && ids.includes(doc.entrypoint) ? [doc.entrypoint] : []), ...ids.filter((id) => id !== doc?.entrypoint)]
  const seats = order.flatMap((id): SeatSpec[] => {
    const agent = agents.find((candidate) => candidate.id === id)
    if (!agent) return []
    if (agent.kind === 'operator') return [{ kind: 'you', id, name: 'You check' }]
    const saved = agent.from?.agent
    const name = agent.name?.trim() || jobs.find((job) => job.id === saved)?.name.trim() || id
    return [{ kind: 'agent', id, name, ...(saved ? { agent: saved } : {}) }]
  })
  const fileName = path.split(/[\\/]/).pop()?.replace(/\.ya?ml$/i, '') ?? path
  return {
    path,
    name: doc.name?.trim() || fileName,
    project: typeof doc.project === 'string' && doc.project.trim() ? doc.project.trim() : null,
    seats,
    // A paused routine doesn't run, so it says nothing here (its team's chat says it is paused).
    schedule: doc.schedule?.cron && doc.schedule.enabled !== false ? scheduleWords(doc.schedule) : null,
  }
}

/** Who in a team's live runs is waiting for you, and who is working: by agent id in the team. */
export function agentStates(runs: readonly RunRecord[]): Map<string, Presence> {
  const states = new Map<string, Presence>()
  for (const run of runs) {
    if (isTerminalRun(run.status)) continue
    for (const id of run.working ?? []) if (states.get(id) !== 'waiting') states.set(id, 'working')
    const waiting = run.waitingOn
    // A review stop waits on the work the agent before it brought; a question, on the agent asking.
    const asking = waiting ? (waiting.kind === 'question' ? waiting.node : waiting.handoverFrom ?? null) : null
    for (const id of [asking, ...(run.permissionRequests ?? []).map((request) => request.agent), ...(run.spendStops ?? []).map((stop) => stop.agent ?? null)]) {
      if (id) states.set(id, 'waiting')
    }
  }
  return states
}

const RANK: Record<Presence, number> = { waiting: 0, working: 1, failed: 2, ready: 3 }

/** The newest moment any of `runs` started or ended. */
function lastOf(runs: readonly RunRecord[]): string | null {
  return runs.reduce<string | null>((found, run) => {
    const at = run.finishedAt ?? run.startedAt ?? run.createdAt
    return !found || at > found ? at : found
  }, null)
}

/**
 * Every project as a room: its teams' desks, each with who is there now. An agent is lit only
 * where it is now: one waiting for you is lit gold at its desk, saying so, as the tiles above say
 * it; one working or waiting in another team, and not here, is faint, naming that team. One working
 * in two projects at once is drawn in each.
 */
export function roomsOf(
  projects: readonly ProjectEntry[],
  shapes: readonly TeamShape[],
  runs: readonly RunRecord[],
  root: string | null,
): Room[] {
  const runsOf = (path: string) => runs.filter((run) => isOpenTeam(path, run.teamPath, root))
  const states = new Map(shapes.map((shape) => [shape.path, agentStates(runsOf(shape.path))]))
  // Where each of My agents is busy, working or waiting for you, by its id there (the teams' names).
  const busyIn = new Map<string, string[]>()
  for (const shape of shapes) {
    for (const seat of shape.seats) {
      const state = states.get(shape.path)?.get(seat.id)
      if (!seat.agent) continue
      if (state === 'waiting' || state === 'working') busyIn.set(seat.agent, [...(busyIn.get(seat.agent) ?? []), shape.name])
    }
  }
  return projects.map((project) => {
    const teams = project.teams.flatMap((path): RoomTeam[] => {
      const shape = shapes.find((candidate) => candidate.path === path)
      if (!shape) return []
      const here = states.get(path) ?? new Map<string, Presence>()
      const teamRuns = runsOf(path)
      const seats = shape.seats.map((spec): Seat => {
        if (spec.kind === 'you') return { ...spec, state: 'ready', away: null }
        const state = here.get(spec.id) ?? 'ready'
        if (state === 'waiting' || state === 'working' || !spec.agent) return { ...spec, state, away: null }
        const elsewhere = (busyIn.get(spec.agent) ?? []).filter((name) => name !== shape.name)
        return { ...spec, state, away: elsewhere.length > 0 ? `in ${elsewhere[0]}` : null }
      })
      const failed = teamRuns.length > 0 && presenceOfNewest(teamRuns) === 'failed'
      const state = seats.some((seat) => seat.state === 'waiting') || teamRuns.some((run) => !isTerminalRun(run.status) && run.waitingOn)
        ? 'waiting'
        : seats.some((seat) => seat.state === 'working') || teamRuns.some((run) => !isTerminalRun(run.status))
          ? 'working'
          : failed ? 'failed' : 'ready'
      return [{ path, name: shape.name, seats, state, schedule: shape.schedule }]
    }).sort(byTeamRank)
    const state = teams[0]?.state ?? 'ready'
    return {
      id: project.id,
      name: project.name,
      ...(project.mark ? { mark: project.mark } : {}),
      putAway: project.putAway === true,
      teams,
      state,
      line: roomLine(teams, state),
      lastWorked: lastOf(project.teams.flatMap(runsOf)),
    }
  })
}

/**
 * A room's teams: waiting for you, then working, then stopped, then the next to run on a schedule,
 * then the rest. Of two teams at work, the one with an agent lit at its desk goes first, so the card
 * shows someone doing it.
 */
function byTeamRank(left: RoomTeam, right: RoomTeam): number {
  return RANK[left.state] - RANK[right.state]
    || Number(litAt(right)) - Number(litAt(left))
    || Number(Boolean(right.schedule)) - Number(Boolean(left.schedule))
}

/** Whether one of a team's desks shows what the team is doing: an agent waiting or working there. */
export function litAt(team: RoomTeam): boolean {
  return team.state !== 'ready' && team.seats.some((seat) => seat.kind === 'agent' && seat.state === team.state)
}

function presenceOfNewest(runs: readonly RunRecord[]): Presence {
  const newest = runs.reduce<RunRecord | null>((found, run) => (!found || found.createdAt < run.createdAt ? run : found), null)
  return newest?.status === 'failed' && !newest.nextTryAt ? 'failed' : 'ready'
}

/**
 * The room's one line, about its first team, the one the card shows: who is waiting, or working, or
 * that it stopped, or when it runs.
 */
export function roomLine(teams: readonly RoomTeam[], state: Presence): string {
  const team = teams[0]
  const seat = team?.seats.find((candidate) => candidate.kind === 'agent' && candidate.state === state)
  if (state === 'waiting' || state === 'working') return seat ? `${seat.name} is ${PRESENCE_WORDS[state]}` : teamWords(team)
  if (state === 'failed') return teamWords(team)
  if (team?.schedule) return `Runs ${team.schedule.charAt(0).toLowerCase()}${team.schedule.slice(1)}`
  return team ? 'Ready' : 'No team yet'
}

/** What a team is doing, after its name: "is working", "is waiting for you", "didn’t finish". */
export function teamStateWords(state: Presence): string {
  return state === 'failed' ? 'didn’t finish' : `is ${PRESENCE_WORDS[state] ?? 'ready'}`
}

/** A team at work, said by its name: "Product pages is working". */
function teamWords(team: RoomTeam | undefined): string {
  return `${team?.name ?? 'A team'} ${teamStateWords(team?.state ?? 'ready')}`
}

/** How many other teams at work a room card names; the rest it counts, so its line stays short. */
export const OTHERS_NAMED = 2

/**
 * What a room card says after its line, when the room has more teams than the one it shows: the
 * other teams at work or stopped, most urgent first, by name, then how many more, and whether
 * those are all quiet.
 */
export function otherTeams(room: Room): { named: { path: string; name: string; state: Presence; words: string }[]; more: number; moreQuiet: boolean } {
  const others = room.teams.slice(1)
  const busy = others.filter((team) => team.state !== 'ready')
  const named = busy.slice(0, OTHERS_NAMED).map((team) => ({ path: team.path, name: team.name, state: team.state, words: teamStateWords(team.state) }))
  return { named, more: others.length - named.length, moreQuiet: busy.length <= OTHERS_NAMED }
}

/**
 * A room's teams in the order they stood when the room opened, so one that starts or stops work
 * doesn't slide under the pointer; a team new since then goes after them.
 */
export function inOpenedOrder<T extends { path: string }>(teams: readonly T[], opened: readonly string[] | null): T[] {
  if (!opened) return [...teams]
  const at = (team: T) => { const index = opened.indexOf(team.path); return index < 0 ? opened.length : index }
  return [...teams].sort((left, right) => at(left) - at(right))
}

/** Rooms in the order the studio shows them: waiting for you, then working, then the rest, newest work first. */
export function rankRooms(rooms: readonly Room[]): Room[] {
  return [...rooms].sort((left, right) =>
    RANK[left.state] - RANK[right.state]
    || (right.lastWorked ?? '').localeCompare(left.lastWorked ?? '')
    || left.name.localeCompare(right.name))
}

/** How many desks a room shows in a team's row before "+N". */
export const SEATS_SHOWN = 4

/** A room's seats as drawn: at most [`SEATS_SHOWN`], and how many more there are. */
export function shownSeats(seats: readonly Seat[]): { shown: Seat[]; more: number } {
  return { shown: seats.slice(0, SEATS_SHOWN), more: Math.max(0, seats.length - SEATS_SHOWN) }
}

/** The words a seat's state is said in, for its label. */
export function seatWords(seat: Seat): string {
  if (seat.kind === 'you') return 'You check'
  if (seat.away) return `${seat.name} is ${seat.away}`
  const words = PRESENCE_WORDS[seat.state]
  return words ? `${seat.name} is ${words}` : seat.name
}

/** Someone at Your desk: an agent who brought something for you, and what. */
export interface DeskItem {
  key: string
  runId: string
  teamPath: string
  teamName: string
  /** The agent, as its seat in its team is: its figure and name. */
  seat: SeatSpec
  says: string
  /** What it asks of you: to check its work, or to answer a question, a permission or a limit. */
  asks: 'check' | 'question' | 'permission' | 'spend'
}

/**
 * Who waits for you, oldest first: the agent whose work a review stop holds, one with a question,
 * one asking before it goes on, one at what it may spend. A run asking with no agent behind it is
 * the team's (a run's own spend limit), drawn as its first agent.
 */
export function deskItems(runs: readonly RunRecord[], shapes: readonly TeamShape[], root: string | null): DeskItem[] {
  const items: (DeskItem & { since: string })[] = []
  for (const run of runs) {
    if (isTerminalRun(run.status)) continue
    const shape = shapes.find((candidate) => isOpenTeam(candidate.path, run.teamPath, root))
    const teamName = shape?.name ?? run.teamName ?? run.teamPath.split(/[\\/]/).pop()?.replace(/\.ya?ml$/i, '') ?? run.teamPath
    const seatOf = (id: string | null | undefined, name?: string | null): SeatSpec => {
      const seat = shape?.seats.find((candidate) => candidate.id === id) ?? (id ? undefined : shape?.seats.find((candidate) => candidate.kind === 'agent'))
      return seat ?? { kind: 'agent', id: id ?? 'team', name: name || (id ? run.agentNames?.[id] : null) || teamName }
    }
    const add = (key: string, seat: SeatSpec, says: string, asks: DeskItem['asks'], since: string) => items.push({ key: `${run.runId}:${key}`, runId: run.runId, teamPath: run.teamPath, teamName, seat, says, asks, since })
    const waiting = run.waitingOn
    if (waiting?.kind === 'question') add(waiting.node, seatOf(waiting.node, waiting.name), 'has a question for you', 'question', waiting.since)
    else if (waiting) add(waiting.node, seatOf(waiting.handoverFrom), 'brought work for you to check', 'check', waiting.since)
    for (const request of run.permissionRequests ?? []) add(request.id, seatOf(request.agent, request.name), 'asks you before it goes on', 'permission', request.since)
    for (const stop of run.spendStops ?? []) add(stop.id, seatOf(stop.agent, stop.name), 'reached its spending limit', 'spend', stop.since)
  }
  return items.sort((left, right) => left.since.localeCompare(right.since)).map(({ since: _since, ...item }) => item)
}

/** More projects than this, and the quiet ones fold into small tiles. */
export const ROOMS_SHOWN = 6

/** Which rooms stand open on Home and which fold into "Not working now" tiles. */
export function studioLayout(rooms: readonly Room[]): { open: Room[]; quiet: Room[]; putAway: Room[] } {
  const ranked = rankRooms(rooms)
  const putAway = ranked.filter((room) => room.putAway)
  const out = ranked.filter((room) => !room.putAway)
  if (out.length <= ROOMS_SHOWN) return { open: out, quiet: [], putAway }
  const busy = out.filter((room) => room.state !== 'ready')
  const open = busy.length > 0 ? busy : out.slice(0, 1)
  return { open, quiet: out.filter((room) => !open.includes(room)), putAway }
}
