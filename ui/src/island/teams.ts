// What the island at the notch shows of each team (ADR 0083): one entry per run that is busy or
// has news, and per message its agents answer in the chat themselves, what it is doing, which agent
// to draw, and what to say. Pure: from the run records and those messages.
import type { NoteAnswering } from '../lib/chat/client'
import { listNames } from '../lib/chat/format'
import { historyRunUrl } from '../lib/runs/history'
import type { RunRecord } from '../lib/runs/client'
import { plainRunError } from '../lib/runs/errors'
import { answerableAtAGlance } from '../lib/runs/permissionRequests'
import type { TeamRequest } from '../lib/runs/teamRequests'
import { ticketsFrom, type Ticket } from '../lib/story/needsYou'
import { teamHref } from '../lib/team-file/teamHref'

/** A question, a stop or a result first; work last (`URGENCY`). */
export type Moment = 'ask' | 'fail' | 'done' | 'work'

export const URGENCY: Record<Moment, number> = { ask: 0, fail: 1, done: 2, work: 3 }

export interface TeamNow {
  /** The run, or the message in the chat its agents are answering. */
  runId: string
  teamPath: string
  teamName: string
  moment: Moment
  /** The agent to draw: the one at work, the one asking, or the last one that worked. */
  agent: string | null
  /** Its name. For agents that didn't answer in the chat, who didn't: one or two names, or `null`
      for three or more. */
  agentName: string | null
  /** The run's agents, in order, for the list's row. */
  agents: readonly string[]
  /** Their names, by id, as the run has them. */
  names?: Readonly<Record<string, string>>
  startedAt: string | null
  /** What waits for you on this run, oldest first: permissions, questions, reviews, spend stops. */
  asks: Ticket[]
  /** The asks that can be answered from the island with Allow or Deny (`answerableAtAGlance`). */
  quick: readonly string[]
  /** For a finished or stopped run: the answer's first line, or what went wrong. */
  result: string | null
  /** Where the run opens in `LoomWatch`. */
  link: string
  /** Agents answering a message in the team's chat themselves (ADR 0076): nothing runs, nobody
      hands over, and it opens the chat. */
  chat: boolean
  /** The agent pinned to the notch, at work in its own chat (`withPinned`). */
  pinned?: boolean
  /** The pinned agent's requests for one of your teams, waiting for Start or Not now. */
  teamAsks?: readonly TeamRequest[]
  /** A team the pinned agent started for you, by the agent's name: its crew. */
  crewFor?: string
  /** A team you pressed Start on that could not start: `result` says why. */
  didNotStart?: boolean
}

const LIVE = new Set(['queued', 'starting', 'running'])

/**
 * Every run the island shows, and every message its agents answer in the chat (`notes`), most
 * urgent first. A finished or stopped run, or an answer, is shown only while it is news: it ended
 * after the island started watching (`since`) and you have not looked yet (`seen`). A cancelled run
 * is never news. `lastAgent` remembers who last worked on a run, for the moments between one
 * agent's turn and the next.
 */
export function teamsNow(
  records: readonly RunRecord[],
  since: number,
  seen: ReadonlySet<string>,
  lastAgent: ReadonlyMap<string, string>,
  notes: readonly NoteAnswering[] = [],
): TeamNow[] {
  const names = new Map(records.flatMap((record) => (record.teamName ? [[record.teamPath, record.teamName] as const] : [])))
  const teams: TeamNow[] = []
  for (const record of records) {
    const live = LIVE.has(record.status)
    const ended = record.status === 'succeeded' || record.status === 'failed'
    if (!live && !(ended && isNews(record.runId, record.finishedAt, since, seen))) continue
    const asks = live ? ticketsFrom([record], names, new Set()).filter((ticket) => ticket.kind !== 'failed') : []
    const moment: Moment = live ? (asks.length ? 'ask' : 'work') : record.status === 'succeeded' ? 'done' : 'fail'
    const agent = agentOf(record, moment, asks[0], lastAgent)
    teams.push({
      runId: record.runId,
      teamPath: record.teamPath,
      teamName: asks[0]?.teamName ?? (record.teamName || teamFromPath(record.teamPath)),
      moment,
      agent,
      agentName: agent ? record.agentNames?.[agent] || agent : null,
      agents: record.agentIds,
      names: record.agentNames,
      startedAt: record.startedAt,
      asks,
      quick: live ? (record.permissionRequests ?? []).filter(answerableAtAGlance).map((request) => `${record.runId}:permission:${request.id}`) : [],
      result: moment === 'done' ? firstLine(record.reply) || 'The answer is ready.' : moment === 'fail' ? (record.error ? plainRunError(record.error).split('\n')[0] : '') || 'Something went wrong before it finished.' : null,
      link: historyRunUrl({ id: record.runId, teamPath: record.teamPath }),
      chat: false,
    })
  }
  for (const note of notes) {
    const answering = noteNow(note, since, seen)
    if (answering) teams.push(answering)
  }
  const started = (team: TeamNow) => Date.parse(team.startedAt ?? '') || 0
  return teams.sort((a, b) => URGENCY[a.moment] - URGENCY[b.moment] || started(a) - started(b))
}

function isNews(id: string, finishedAt: string | null | undefined, since: number, seen: ReadonlySet<string>): boolean {
  const finished = Date.parse(finishedAt ?? '')
  return Number.isFinite(finished) && finished >= since && !seen.has(id)
}

/**
 * A message its agents answer in the chat: at work while any of them writes, then done, with the
 * first answer's opening, while that is news. When nobody answered because their turns failed, it
 * stopped: who didn't answer, and why. When none of them had anything to add, there is nothing to
 * show.
 */
function noteNow(note: NoteAnswering, since: number, seen: ReadonlySet<string>): TeamNow | null {
  const { waiting, said } = note.answers
  const failed = note.answers.failed ?? []
  const live = waiting.length > 0
  if (!live && !((said.length || failed.length) && isNews(note.messageId, note.finishedAt, since, seen))) return null
  // An answer is the news when there is one; the chat says who else didn't answer.
  const moment: Moment = live ? 'work' : said.length ? 'done' : 'fail'
  const agent = live ? waiting[0] : said[0]?.from ?? failed[0].from
  return {
    runId: note.messageId,
    teamPath: note.teamPath,
    teamName: note.teamName || teamFromPath(note.teamPath),
    moment,
    agent,
    agentName: moment === 'fail' ? whoDidNotAnswer(note, failed.map((failure) => failure.from)) : note.agentNames[agent] || agent,
    agents: Object.keys(note.agentNames),
    startedAt: note.createdAt,
    asks: [],
    quick: [],
    result: moment === 'done' ? firstLine(said[0].text) || 'The answer is ready.' : moment === 'fail' ? plainRunError(failed[0].error).split('\n')[0] || 'Something went wrong before it answered.' : null,
    link: teamHref(note.teamPath, 'chat'),
    chat: true,
  }
}

/** Who didn't answer, as the chat's card names them: one or two by name; for three or more, none,
    and the team is named. */
function whoDidNotAnswer(note: NoteAnswering, ids: readonly string[]): string | null {
  return ids.length > 2 ? null : listNames(ids.map((id) => note.agentNames[id] || id))
}

function agentOf(record: RunRecord, moment: Moment, ask: Ticket | undefined, lastAgent: ReadonlyMap<string, string>): string | null {
  const last = lastAgent.get(record.runId) ?? null
  if (moment === 'ask' && ask) {
    // A permission's or a question's asker; a review stop is about the work handed to it.
    if (ask.kind === 'permission' || ask.kind === 'question') return ask.node
    if (ask.kind === 'review') return record.waitingOn?.handoverFrom ?? last
    return ask.node ?? record.working?.[0] ?? last
  }
  return record.working?.[0] ?? last ?? (moment === 'work' ? null : record.agentIds.at(-1) ?? null)
}

function teamFromPath(path: string): string {
  return (path.split('/').at(-1) ?? path).replace(/\.ya?ml$/, '')
}

/** The answer's first line of text, without its Markdown, short enough for one line or two. */
export function firstLine(reply: string | null | undefined): string {
  for (const raw of (reply ?? '').split('\n')) {
    const line = raw
      .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~]+/g, '')
      .trim()
    if (line && !/^-{3,}$/.test(line)) return line.length > 120 ? `${line.slice(0, 119).trimEnd()}…` : line
  }
  return ''
}

/**
 * An answer as plain text, for reading at the notch: its lines without Markdown's marks, links as
 * their words.
 */
export function plainText(reply: string | null | undefined): string {
  return unmarked(reply, (words) => words)
}

/**
 * An answer as plain text, for an app that takes no formatting: as {@link plainText}, but each
 * link keeps its address after its words, so a pasted answer still leads to its sources.
 */
export function copyText(reply: string | null | undefined): string {
  return unmarked(reply, (words, address) => (!words || words === address ? address : `${words} (${address})`))
}

/** `reply`'s lines without Markdown's marks, a link said by `link(words, address)`. */
function unmarked(reply: string | null | undefined, link: (words: string, address: string) => string): string {
  return (reply ?? '')
    .split('\n')
    // A code block keeps its lines and loses its fences.
    .filter((line) => !/^\s*(```|~~~)/.test(line))
    .map((line) => line
      .replace(/^\s*(#{1,6}\s+|>\s*)/, '')
      .replace(/^(\s*)[-*+]\s+/, '$1• ')
      .replace(/!?\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+["'][^"']*["'])?\s*\)/g, (_link, words: string, address: string) => link(words, address))
      .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
      .replace(/(\*\*|__|`)/g, '')
      .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,;:!?]|$)/g, '$1$2'))
    .filter((line, index, lines) => !/^-{3,}$/.test(line.trim()) && !(line.trim() === '' && lines[index - 1]?.trim() === ''))
    .join('\n')
    .trim()
}

/** What popped out of the island, or waits to. */
export type PopKind = 'start' | 'handover' | 'ask' | 'done' | 'fail'

export interface Pop {
  kind: PopKind
  runId: string
  /** What it is about: the agent that started or took over, the question, or the run. */
  key: string
}

/**
 * The moments that happened between two readings: a team starting, one agent handing over to the
 * next, a new question, a run finishing or stopping. On the island's first reading (`before` is
 * `null`) only what already waits for you counts: it was not seen yet either.
 */
export function momentsBetween(before: readonly TeamNow[] | null, after: readonly TeamNow[]): Pop[] {
  const pops: Pop[] = []
  for (const team of after) {
    const was = before?.find((candidate) => candidate.runId === team.runId)
    for (const ask of team.asks) {
      if (!was?.asks.some((old) => old.id === ask.id)) pops.push({ kind: 'ask', runId: team.runId, key: ask.id })
    }
    for (const ask of team.teamAsks ?? []) {
      if (!was?.teamAsks?.some((old) => old.id === ask.id)) pops.push({ kind: 'ask', runId: team.runId, key: teamAskKey(ask) })
    }
    if (!before) continue
    if ((team.moment === 'done' || team.moment === 'fail') && was?.moment !== team.moment) {
      pops.push({ kind: team.moment, runId: team.runId, key: team.runId })
    } else if (team.moment === 'work' && team.agent) {
      if (!was) pops.push({ kind: 'start', runId: team.runId, key: team.agent })
      // Agents answering in the chat answer at the same time: when one is done, the next was
      // already writing, and nothing was handed over.
      else if (!team.chat && was.agent && was.agent !== team.agent) pops.push({ kind: 'handover', runId: team.runId, key: team.agent })
    }
  }
  return pops
}

/** What the island at rest shows beside the notch. */
export interface Tucked {
  /** The work of the agent pinned to the notch, which its own figure, always first beside the
      notch, shows; `null` while it does none. */
  pinned: TeamNow | null
  /** One per other team, most urgent first, at most three. */
  heads: TeamNow[]
  /** Teams beyond those. */
  more: number
  /** Every question, permission, review and spend stop, across all teams. */
  asks: number
  /** On the right: the count of what waits, a slip for a result (finished or stopped) you have not
      seen, or how long a single team has worked. */
  right: 'count' | 'slip' | 'time' | 'none'
}

export const HEADS = 3

/** A pinned agent's team request, as the island queues it beside the questions. */
export const teamAskKey = (request: Pick<TeamRequest, 'id'>): string => `team:${request.id}`

export function tucked(teams: readonly TeamNow[]): Tucked {
  const asks = teams.reduce((sum, team) => sum + team.asks.length + (team.teamAsks?.length ?? 0), 0)
  const right = asks ? 'count' : teams.some((team) => team.moment === 'done' || team.moment === 'fail') ? 'slip' : teams.length === 1 && teams[0].moment === 'work' ? 'time' : 'none'
  const others = teams.filter((team) => !team.pinned)
  return { pinned: teams.find((team) => team.pinned) ?? null, heads: others.slice(0, HEADS), more: Math.max(0, others.length - HEADS), asks, right }
}

/** How long a run has been at work: "4m" beside the notch, "4 min" in the list; hours past one.
    Nothing in its first minute. */
export function workedFor(startedAt: string | null, now: number, words: 'short' | 'long' = 'short'): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(startedAt ?? '')) / 60_000))
  if (!Number.isFinite(minutes) || minutes < 1) return ''
  if (minutes < 60) return words === 'short' ? `${minutes}m` : `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return words === 'short' ? `${hours}h` : `${hours} h`
}
