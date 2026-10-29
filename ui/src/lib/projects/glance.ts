import { extensionOf } from '../files/fileRefs'
import { baseName } from '../files/paths'
import { readerFormat } from '../files/reader'
import { isOpenTeam } from '../library/uses'
import { benchChatId } from '../rail/presence'
import { isTerminalRun, type RunRecord, type ScheduleEntry } from '../runs/client'
import { problemAction, type ProblemAction } from '../runs/errors'
import { ticketsFrom } from '../story/needsYou'
import type { UsageReport } from '../usage/client'
import { formatCost } from '../watch/usage'
import { deskItems, type DeskItem, type RoomTeam, type Seat, type SeatSpec, type TeamShape } from './studio'

/**
 * What a project's room and Home show at a glance (ADR 0097): what needs you, who is working,
 * what runs next, what this month cost and what the agents made, worked out from the runs, the
 * schedules and the teams' files, so the tiles only lay it out. `scope` is the teams a room holds,
 * by the paths its project lists; `null` is every team, as Home shows them.
 */
export type Scope = readonly string[] | null

/** The team `run` belongs to, as `scope` names it; `null` when it is outside it. */
function teamIn(scope: Scope, run: Pick<RunRecord, 'teamPath'>, root: string | null): string | null {
  if (!scope) return run.teamPath
  return scope.find((path) => isOpenTeam(path, run.teamPath, root)) ?? null
}

const newestFirst = (left: RunRecord, right: RunRecord) => (right.finishedAt ?? right.createdAt).localeCompare(left.finishedAt ?? left.createdAt)

/** Something that needs you: work brought for you to check or a question, or work that stopped. */
export interface NeedsYouItem {
  key: string
  kind: 'waiting' | 'failed'
  runId: string
  /** The team as the run names it, for its links. */
  teamPath: string
  teamName: string
  /** Who to draw: the agent waiting, or the one whose answer the run that stopped was to give. */
  seat: SeatSpec
  says: string
  /** What a waiting agent asks of you, which names its button: check its work, or answer. */
  asks?: DeskItem['asks']
  /** Why the work stopped, in plain words. */
  reason?: string
  /** The fix LoomWatch knows for why it stopped, such as adding credits. */
  fix?: ProblemAction | null
}

/**
 * What needs you, by the bell's own rules so the two never count differently: whoever waits for
 * you, oldest first; then the work that stopped in the last day, which the schedule won't try again
 * and the person hasn't dismissed in the bell's list.
 */
export function needsYou(runs: readonly RunRecord[], shapes: readonly TeamShape[], root: string | null, scope: Scope = null, dismissed: ReadonlySet<string> = new Set(), now = Date.now()): NeedsYouItem[] {
  const waiting = deskItems(runs, shapes, root)
    .filter((item) => teamIn(scope, item, root) !== null)
    .map((item): NeedsYouItem => ({ key: item.key, kind: 'waiting', runId: item.runId, teamPath: item.teamPath, teamName: item.teamName, seat: item.seat, says: item.says, asks: item.asks }))
  const names = new Map(shapes.map((shape) => [shape.path, shape.name]))
  const stopped = ticketsFrom(runs, names, dismissed, now)
    .filter((ticket) => ticket.kind === 'failed' && teamIn(scope, ticket, root) !== null)
    .map((ticket): NeedsYouItem => {
      const run = runs.find((candidate) => candidate.runId === ticket.runId)
      const shape = shapes.find((candidate) => isOpenTeam(candidate.path, ticket.teamPath, root))
      const responder = run?.responder ?? ''
      const seat = shape?.seats.find((candidate) => candidate.id === responder) ?? shape?.seats.find((candidate) => candidate.kind === 'agent') ?? { kind: 'agent', id: responder, name: ticket.teamName }
      return { key: ticket.id, kind: 'failed', runId: ticket.runId, teamPath: ticket.teamPath, teamName: shape?.name ?? ticket.teamName, seat, says: 'didn’t finish', reason: ticket.text, fix: problemAction(run?.error) }
    })
  return [...waiting, ...stopped]
}

/** An agent at work now, on what, and in which team. */
export interface AtWork {
  key: string
  runId: string
  teamPath: string
  teamName: string
  seat: SeatSpec
  /** The work it was given, in the words it was given in. */
  prompt: string
  since: string
}

/** The desk a run's agent `id` sits at; in an agent's own chat, that agent, so it wears its figure. */
function seatIn(shape: TeamShape | undefined, run: Pick<RunRecord, 'teamPath' | 'agentNames'>, id: string): SeatSpec {
  const seat = shape?.seats.find((candidate) => candidate.id === id)
  if (seat) return seat
  const chat = benchChatId(run.teamPath)
  return { kind: 'agent', id, name: run.agentNames?.[id] ?? id, ...(chat ? { agent: chat } : {}) }
}

/** Who gave a piece of work's answer, as its team's desk is, and where the work was given. */
export interface DoneBy {
  seat: SeatSpec
  place: string
}

export function doneByOf(shapes: readonly TeamShape[], root: string | null): (run: Pick<RunRecord, 'teamPath' | 'teamName' | 'responder' | 'agentNames'>) => DoneBy {
  return (run) => {
    const shape = shapes.find((candidate) => isOpenTeam(candidate.path, run.teamPath, root))
    return { seat: seatIn(shape, run, run.responder), place: benchChatId(run.teamPath) ? 'your chat' : shape?.name ?? placeOf(run) }
  }
}

/** Where a piece of work was given, as a person says it: its team, or "your chat" with one agent. */
export function placeOf(run: Pick<RunRecord, 'teamPath' | 'teamName'>): string {
  if (benchChatId(run.teamPath)) return 'your chat'
  return run.teamName ?? baseName(run.teamPath).replace(/\.ya?ml$/i, '')
}

/**
 * When work began, as a person reads a clock: "just started", "started 4 min ago", "started 1 h 5
 * min ago". Never "4 min" alone, which could be read as the time left.
 */
export function elapsedWords(since: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(since)) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 1) return 'just started'
  if (minutes < 60) return `started ${minutes} min ago`
  const rest = minutes % 60
  return `started ${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ''} ago`
}

/**
 * The agents at the teams' desks, each once, as each is now: one of My agents at desks in two
 * teams is drawn where it is lit, not where it is away.
 */
export function crewOf(teams: readonly Pick<RoomTeam, 'path' | 'seats'>[]): Seat[] {
  const crew = new Map<string, Seat>()
  for (const team of teams) {
    for (const seat of team.seats) {
      if (seat.kind !== 'agent') continue
      const key = seat.agent ?? `${team.path}\n${seat.id}`
      const held = crew.get(key)
      if (!held || (held.away && !seat.away)) crew.set(key, seat)
    }
  }
  return [...crew.values()]
}

/** Who is working now, longest at it first: the agents in a turn of work, or a run's first agent while it starts. */
export function workingNow(runs: readonly RunRecord[], shapes: readonly TeamShape[], root: string | null, scope: Scope = null): AtWork[] {
  return runs
    .filter((run) => !isTerminalRun(run.status) && !run.waitingOn && teamIn(scope, run, root) !== null)
    .sort((left, right) => (left.startedAt ?? left.createdAt).localeCompare(right.startedAt ?? right.createdAt))
    .flatMap((run) => {
      const shape = shapes.find((candidate) => isOpenTeam(candidate.path, run.teamPath, root))
      const teamName = shape?.name ?? run.teamName ?? run.teamPath.split(/[\\/]/).pop()?.replace(/\.ya?ml$/i, '') ?? run.teamPath
      const ids = run.working?.length ? run.working : [run.responder]
      return ids.map((id): AtWork => ({
        key: `${run.runId}:${id}`,
        runId: run.runId,
        teamPath: run.teamPath,
        teamName,
        seat: seatIn(shape, run, id),
        prompt: run.prompt,
        since: run.startedAt ?? run.createdAt,
      }))
    })
}

/** A team's next run on its schedule. */
export interface NextRun {
  teamPath: string
  teamName: string
  at: string
}

/** The next runs on a schedule, soonest first: at most `count`. */
export function nextWork(entries: readonly ScheduleEntry[], root: string | null, scope: Scope = null, count = 2): NextRun[] {
  return entries
    .filter((entry) => entry.enabled && entry.nextAt && !entry.problem && teamIn(scope, entry, root) !== null)
    .sort((left, right) => (left.nextAt ?? '').localeCompare(right.nextAt ?? ''))
    .slice(0, count)
    .map((entry) => ({ teamPath: entry.teamPath, teamName: entry.teamName, at: entry.nextAt as string }))
}

/** What the runs started this month cost, in all and by team, from what each run counted. */
export interface MonthSpend {
  usd: number
  runs: number
  /** A run this month counted nothing (one recorded before runs kept it): the sum is a floor. */
  atLeast: boolean
  /** By team, as `scope` names it (as the run names it on Home). */
  byTeam: Map<string, { usd: number; runs: number }>
}

export function monthSpend(runs: readonly RunRecord[], root: string | null, scope: Scope = null, now = new Date()): MonthSpend {
  const since = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  const spend: MonthSpend = { usd: 0, runs: 0, atLeast: false, byTeam: new Map() }
  for (const run of runs) {
    const team = teamIn(scope, run, root)
    if (team === null || Date.parse(run.createdAt) < since) continue
    const usd = run.spend?.spentUsd ?? 0
    spend.usd += usd
    spend.runs += 1
    if (!run.spend) spend.atLeast = true
    const counted = spend.byTeam.get(team) ?? { usd: 0, runs: 0 }
    spend.byTeam.set(team, { usd: counted.usd + usd, runs: counted.runs + 1 })
  }
  return spend
}

/** What this month cost by where it was paid, as the Usage page counts it (ADR 0073). */
export interface MonthCost {
  /** Dollars through OpenRouter and the Claude credit. */
  usd: number
  /** Some of it was worked out from list prices (a Claude key reports no cost). */
  estimated: boolean
  /** Some work ran on a ChatGPT plan, which has no price per call. */
  plan: boolean
}

/**
 * This month's cost from the usage report, for the teams named (`null`: every team, and Ask). The
 * report counts what each call cost where it was paid, so a ChatGPT plan is said as a plan rather
 * than as $0, and a list-price estimate as one.
 */
export function monthCost(report: UsageReport | null, teams: readonly string[] | null): MonthCost | null {
  if (!report) return null
  const tallies = teams ? report.agents.filter((agent) => agent.team && teams.includes(agent.team)) : report.sources.map((source) => ({ ...source.total, source: source.source }))
  return {
    usd: tallies.reduce((sum, tally) => sum + tally.costUsd, 0),
    estimated: tallies.some((tally) => tally.costEstimated && tally.costUsd > 0),
    plan: tallies.some((tally) => tally.source === 'chatgpt' && tally.calls > 0),
  }
}

/** A month's cost in words: "$0.42", "≈ $0.42", "$0.42 + ChatGPT plan", "ChatGPT plan", "$0". */
export function costWords(cost: MonthCost): string {
  const dollars = cost.usd > 0 ? `${cost.estimated ? '≈ ' : ''}${formatCost(cost.usd)}` : null
  if (dollars && cost.plan) return `${dollars} + ChatGPT plan`
  if (cost.plan) return 'ChatGPT plan'
  return dollars ?? '$0'
}

/** A month's cost as the tile says it: the dollars, then "+ ChatGPT plan" under them when a plan paid for some. */
export function costLines(cost: MonthCost): { main: string; plan: string | null } {
  const [main, plan] = costWords(cost).split(' + ')
  return { main, plan: plan ? `+ ${plan}` : null }
}

/** One agent's part of this month's dollars. */
export interface Spender {
  key: string
  seat: SeatSpec
  usd: number
  /** Some of it was worked out from list prices. */
  estimated: boolean
}

/**
 * Who this month's dollars went to, the costliest first, from the usage report: each agent of the
 * teams named (`null`: every team) once, whatever it ran through and in however many teams. Ask,
 * LoomWatch's own reading of messages (in no team), and work a plan paid for are nobody's part here.
 * An agent's own chat is found by its name among My agents, since the report names a team only by
 * its name.
 */
export function monthSpenders(report: UsageReport | null, teams: readonly string[] | null, shapes: readonly TeamShape[], jobs: readonly { id: string; name: string }[]): Spender[] {
  if (!report) return []
  const parts = new Map<string, Spender>()
  for (const tally of report.agents) {
    if (tally.ask || !tally.team || tally.costUsd <= 0 || (teams && !teams.includes(tally.team))) continue
    const name = tally.agentName ?? tally.agentId
    const shape = shapes.find((candidate) => candidate.name === tally.team)
    const job = shape ? undefined : jobs.find((candidate) => candidate.name === name)
    const seat: SeatSpec = shape?.seats.find((candidate) => candidate.id === tally.agentId) ?? { kind: 'agent', id: tally.agentId, name, ...(job ? { agent: job.id } : {}) }
    const key = seat.agent ?? `${tally.team ?? ''}\n${seat.id}`
    const held = parts.get(key)
    parts.set(key, { key, seat: held?.seat ?? seat, usd: (held?.usd ?? 0) + tally.costUsd, estimated: Boolean(held?.estimated) || tally.costEstimated })
  }
  return [...parts.values()].sort((left, right) => right.usd - left.usd)
}

/** Whether a file the agents made is worth showing as made: what a person reads, not code or a log. */
export function isMadeThing(path: string): boolean {
  return readerFormat(path) !== 'code' && extensionOf(path) !== 'log'
}

/** A file the agents made. */
export interface MadeFile {
  path: string
  runId: string
  /** The team, as `scope` names it, for filtering; as the run names it, for links. */
  team: string
  teamPath: string
  /** The agent whose answer the run gave, to ask about it. */
  from: string
  at: string
}

/** What the agents made, newest work first, each file once, at most `count`. */
export function madeHere(runs: readonly RunRecord[], root: string | null, scope: Scope = null, count = 60): MadeFile[] {
  const seen = new Set<string>()
  const files: MadeFile[] = []
  for (const run of runs.filter((candidate) => isTerminalRun(candidate.status) && candidate.made?.length).sort(newestFirst)) {
    const team = teamIn(scope, run, root)
    if (team === null) continue
    for (const path of run.made ?? []) {
      if (seen.has(path) || !isMadeThing(path)) continue
      seen.add(path)
      files.push({ path, runId: run.runId, team, teamPath: run.teamPath, from: run.responder, at: run.finishedAt ?? run.createdAt })
      if (files.length >= count) return files
    }
  }
  return files
}

/** The newest work that finished well, and the first thing it made. */
export function lastFinished(runs: readonly RunRecord[], root: string | null, scope: Scope = null): { run: RunRecord; file: string | null } | null {
  const run = runs.filter((candidate) => candidate.status === 'succeeded' && teamIn(scope, candidate, root) !== null).sort(newestFirst)[0]
  return run ? { run, file: run.made?.find(isMadeThing) ?? null } : null
}

/** When a scheduled run comes, as a person says it: "in 20 minutes", "today at 5:00 PM", "Monday at 9:00 AM". */
export function whenNext(iso: string, now = new Date()): string {
  const at = new Date(iso)
  const minutes = Math.round((at.getTime() - now.getTime()) / 60_000)
  if (!Number.isFinite(minutes)) return ''
  if (minutes <= 0) return 'now'
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const days = Math.round((new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000)
  if (days === 0) return `today at ${time}`
  if (days === 1) return `tomorrow at ${time}`
  if (days < 7) return `${at.toLocaleDateString(undefined, { weekday: 'long' })} at ${time}`
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** The work that finished well today, newest first. */
export function finishedToday(runs: readonly RunRecord[], root: string | null, scope: Scope = null, now = new Date()): RunRecord[] {
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return runs.filter((run) => run.status === 'succeeded' && run.finishedAt && Date.parse(run.finishedAt) >= since && teamIn(scope, run, root) !== null).sort(newestFirst)
}
