import { extensionOf } from '../files/fileRefs'
import { readerFormat } from '../files/reader'
import { isOpenTeam } from '../library/uses'
import { isTerminalRun, type RunRecord, type ScheduleEntry } from '../runs/client'
import { problemAction, type ProblemAction } from '../runs/errors'
import { ticketsFrom } from '../story/needsYou'
import type { UsageReport } from '../usage/client'
import { formatCost } from '../watch/usage'
import { deskItems, type DeskItem, type SeatSpec, type TeamShape } from './studio'
import { STATE_WORDS } from '../state/words'

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
      return { key: ticket.id, kind: 'failed', runId: ticket.runId, teamPath: ticket.teamPath, teamName: shape?.name ?? ticket.teamName, seat, says: STATE_WORDS.failed, reason: ticket.text, fix: problemAction(run?.error) }
    })
  return [...waiting, ...stopped]
}

/** An agent at work now, and in which team. */
export interface AtWork {
  key: string
  runId: string
  teamPath: string
  teamName: string
  seat: SeatSpec
  since: string
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
        seat: shape?.seats.find((seat) => seat.id === id) ?? { kind: 'agent', id, name: run.agentNames?.[id] ?? id },
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
