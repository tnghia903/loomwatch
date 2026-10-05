import type { Evidence, RunProjection } from '../watch/events'
import { commandName } from './commands'
import { failuresOf, mendOf, skillName, workCount, type MendHow, type WorkCount } from './reads'

/**
 * A run as woven cloth, for the weft timeline.
 *
 * Each helper is a lane (the warp). Where it worked, a thread runs along its lane; every recorded
 * call is a stitch on that thread; a handoff is a knot that carries the thread down to the next
 * lane. Scrubbing across it reads the run back like a video, and each moment has a sentence for a
 * newcomer and the event kind and sequence number for an expert.
 *
 * Pure and derived only from the projection: nothing here is guessed from prose.
 */
export interface WeftLane {
  id: string
  name: string
  operator: boolean
  /** Milliseconds from the run's first event. `null` when this helper never ran. */
  start: number | null
  end: number | null
  live: boolean
  status: string
  /** The projected task state, so a lane's mark says the same thing as the agent's card. */
  taskState?: string
}

export interface WeftStitch {
  at: number
  laneId: string
  kind: Evidence['kind']
  evidenceId: string
  /** The recorded call, so the story can judge it by outcome as the receipt does (lib/story/reads.ts). */
  evidence: Evidence
  /** The call failed and nothing the agent did after made up for it, as the receipt judges it. */
  bad: boolean
  /**
   * The call failed, but the agent got what it was after another way: ran the command again, read
   * the files in a folder it could not read as a file. Drawn as a muted stitch darned to `at`, the
   * call that mended it, rather than as a red one the receipt no longer counts.
   */
  mended: { evidenceId: string; at: number; how: MendHow } | null
  /** For a newcomer: "Researcher read file README.md." */
  sentence: string
  /** For an expert: "file · read file · #212". */
  code: string
}

export interface WeftKnot {
  at: number
  from: string
  to: string
  /** The recorded relation ("asked", "handed off to", "dispatched"); a relay stage hands off. */
  relation: string
}

export interface Weft {
  duration: number
  lanes: WeftLane[]
  stitches: WeftStitch[]
  knots: WeftKnot[]
  live: boolean
}

export interface WeftAgent {
  id: string
  name: string
  operator: boolean
  /**
   * The agent's status as the rest of the run view shows it, when known. The raw projection still
   * calls a stage "running" after it handed over and was parked; the cards correct that from the run
   * record, and the timeline must say the same thing, so it takes the same value.
   */
  status?: string
  taskState?: string
}

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN)

/**
 * The thing a call acted on, short enough for a sentence: a site's host for a URL, a file's name
 * for a path, the query for a search — with the verb a harness put in its title ("Read …",
 * "Fetch …") taken off, since the sentence already has one.
 */
export function shortName(name: string): string {
  let text = name.split('\n')[0].trim()
  text = text.replace(/^(web search|read|fetch(?:ing)?|open(?:ed)?|search(?:ed)?(?: for)?|run|ran|edit|write|view|list|grep|glob)\b[:\s]+/i, '').trim()
  text = text.replace(/^["'“]+|["'”]+$/g, '')
  const url = text.match(/https?:\/\/[^\s'"]+/)?.[0]
  if (url) {
    try { return new URL(url).hostname.replace(/^www\./, '') } catch { /* not a URL after all */ }
  }
  const path = text.match(/(?:^|\s|['"])(\/[^\s'"]+)/)?.[1]
  const label = path ? path.split('/').filter(Boolean).at(-1) ?? text : text
  return label.length > 64 ? `${label.slice(0, 61)}…` : label
}

/** One recorded call as a sentence, in the words a person would use for that kind of call. */
export function describeEvidence(agent: string, item: Pick<Evidence, 'kind' | 'relation' | 'name' | 'status' | 'target'> & Partial<Pick<Evidence, 'rawInput'>>): string {
  const what = shortName(item.name)
  const failed = item.status === 'failed' || item.status === 'rejected'
  const quoted = what ? `“${what}”` : 'something'
  switch (item.kind) {
    case 'delegation': return item.target ? `${agent} ${item.relation} ${item.target}${failed ? ', which failed' : ''}.` : `${agent} ${item.relation}${failed ? ', which failed' : ''}.`
    // The operator's own answer is filed as a source of the next stage, but nobody "opened" it.
    case 'source': return item.relation === 'directed' ? `${agent} answered.` : failed ? `${agent} couldn’t open ${what || 'a source'}.` : `${agent} opened ${what || 'a source'}.`
    case 'search': return failed ? `${agent}’s search for ${quoted} failed.` : `${agent} searched for ${quoted}.`
    case 'file': {
      const verb = item.relation.replace(/ file$/, '')
      const base: Record<string, string> = { read: 'read', edited: 'edit', deleted: 'delete', moved: 'move' }
      return failed ? `${agent} couldn’t ${base[verb] ?? 'use'} ${what || 'a file'}.` : `${agent} ${verb} ${what || 'a file'}.`
    }
    case 'command': {
      // Named by the program it ran, not the folder it ran in: `cd /tmp/build && python3 build.py`
      // is "python3 build.py", where the first path in it would make every command there "build".
      const named = commandName(item.name)
      const command = named ? `“${named}”` : quoted
      return failed ? `${agent}’s command ${command} failed.` : `${agent} ran ${command}.`
    }
    case 'skill': {
      // A skill read as its SKILL.md is named by its folder; Claude's Skill tool ("Load skill: x") by its input.
      const named = skillName(item)
      const skill = named ? `“${named}”` : quoted
      return failed ? `${agent} couldn’t use the skill ${skill}.` : `${agent} used the skill ${skill}.`
    }
    case 'permission': {
      // A request to run a command names it as the command itself is named once it runs.
      const request = item.rawInput as { toolCall?: { kind?: unknown } } | null | undefined
      const named = request?.toolCall?.kind === 'execute' ? commandName(item.name) : null
      return `${agent} asked permission for ${named ? `“${named}”` : quoted}${failed ? ', and it was refused' : ''}.`
    }
    default: return failed ? `${agent}’s ${quoted} call failed.` : `${agent} used ${quoted}.`
  }
}

/** How a mended stitch's sentence ends: "Editor’s command “python3 build.py” failed, then worked when run again." */
const MENDED: Record<MendHow, string> = {
  'ran again': 'then worked when run again',
  'tried again': 'then worked on another try',
  'read before': 'but had already read it',
  'read inside': 'but read the files in it',
  'opened another way': 'but opened it another way',
}

/**
 * The line the record's panel shows under a failed call that was mended, as a link to the call
 * that mended it. `afterMs` is how long after the failure that call came (negative: before it).
 */
export function mendNote(how: MendHow, afterMs: number): string {
  const gap = span(Math.abs(afterMs))
  switch (how) {
    case 'ran again': return `Ran again ${gap} later and worked`
    case 'tried again': return `Worked on another try ${gap} later`
    case 'read before': return `Already read ${gap} earlier`
    case 'read inside': return 'Read the files in it instead'
    case 'opened another way': return 'Opened the skill another way'
  }
}

function stitchSentence(agent: string, item: Evidence): string {
  return describeEvidence(agent, item)
}

/**
 * `relay` is true for a pipeline: its stages hand work along in order, so those handoffs are drawn
 * even when the run also recorded asks between stages, and a stage's thread ends at its last real
 * activity rather than when its harness was finally closed.
 */
export function weave(projection: RunProjection, order: readonly WeftAgent[], now = Date.now(), relay = true): Weft {
  const t0 = ms(projection.startedAt)
  const live = !['succeeded', 'partial', 'failed', 'cancelled'].includes(projection.phase)
  const byId = new Map(projection.agents.map((agent) => [agent.id, agent]))
  const name = new Map(order.map((agent) => [agent.id, agent.name]))
  // Helpers the run produced but the team file does not list (recruited in team mode) still get a lane.
  const laneOrder: WeftAgent[] = [...order, ...projection.agents.filter((agent) => !name.has(agent.id)).map((agent) => ({ id: agent.id, name: agent.id, operator: false }))]
  const lastEvent = Math.max(0, ...projection.agents.map((agent) => ms(agent.lastTs) - t0).filter(Number.isFinite), ...projection.evidence.map((item) => item.offsetMs))
  const duration = Number.isFinite(t0) ? Math.max(1000, live ? Math.max(lastEvent, now - t0) : lastEvent) : Math.max(1000, lastEvent)

  const lanes: WeftLane[] = laneOrder.map((agent) => {
    const projected = byId.get(agent.id)
    const status = agent.status ?? projected?.status ?? 'idle'
    const start = projected && Number.isFinite(t0) ? Math.max(0, ms(projected.firstTs) - t0) : null
    const running = status === 'running' || status === 'starting'
    const end = projected && Number.isFinite(t0) ? (running && live ? duration : Math.max(start ?? 0, ms(projected.lastTs) - t0)) : null
    return { id: agent.id, name: agent.name, operator: agent.operator, start, end, live: running && live, status, taskState: agent.taskState ?? projected?.taskState }
  })

  const label = (id: string) => name.get(id) ?? id
  // Each agent's calls, as the receipt is given them, so a failure is judged the same way in both.
  const callsOf = new Map<string, Evidence[]>()
  for (const item of projection.evidence) callsOf.set(item.agentId, [...(callsOf.get(item.agentId) ?? []), item])
  const stitches: WeftStitch[] = projection.evidence
    .filter((item) => item.kind !== 'plan')
    .map((item) => {
      const failed = item.status === 'failed' || item.status === 'rejected'
      const mend = failed && item.kind !== 'permission' ? mendOf(item, callsOf.get(item.agentId) ?? []) : null
      const sentence = stitchSentence(label(item.agentId), item.target ? { ...item, target: label(item.target) } : item)
      return {
        at: item.offsetMs,
        laneId: item.agentId,
        kind: item.kind,
        evidenceId: item.id,
        evidence: item,
        bad: failed && !mend,
        mended: mend ? { evidenceId: mend.by.id, at: mend.by.offsetMs, how: mend.how } : null,
        sentence: mend ? `${sentence.replace(/\.$/, '')}, ${MENDED[mend.how]}.` : sentence,
        code: `${item.kind} · ${item.relation} · #${item.seq}`,
      }
    })
    .sort((a, b) => a.at - b.at)

  // Knots: a recorded delegation is the honest source; a pipeline's stage order is the fallback,
  // drawn where the next stage's thread begins.
  const knots: WeftKnot[] = projection.evidence
    .filter((item) => item.kind === 'delegation' && item.target && lanes.some((lane) => lane.id === item.target))
    .map((item) => ({ at: item.offsetMs, from: item.agentId, to: item.target as string, relation: item.relation }))
  if (relay || knots.length === 0) {
    const ran = lanes.filter((lane) => lane.start !== null).sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
    for (let index = 1; index < ran.length; index += 1) {
      knots.push({ at: ran[index].start as number, from: ran[index - 1].id, to: ran[index].id, relation: 'handed off to' })
      // In a relay a stage's work ends when it hands over; a harness kept alive after that (for
      // follow-ups, or a parked review) is waiting, not working — unless the record shows it doing
      // something later, such as answering a later stage's question.
      const previous = ran[index - 1]
      if (previous.end === null || previous.live) continue
      const laterWork = Math.max(
        ...stitches.filter((stitch) => stitch.laneId === previous.id).map((stitch) => stitch.at),
        ...knots.filter((knot) => knot.to === previous.id || knot.from === previous.id).map((knot) => knot.at),
        0,
      )
      previous.end = Math.min(previous.end, Math.max(previous.start ?? 0, ran[index].start as number, laterWork))
    }
    knots.sort((a, b) => a.at - b.at)
  }
  return { duration, lanes, stitches, knots, live }
}

/** A change of hands, in the words of the call that made it. */
export function knotSentence(knot: Pick<WeftKnot, 'relation'>, from: string, to: string): string {
  switch (knot.relation) {
    case 'asked': return `${from} asked ${to} a question.`
    case 'dispatched': return `${from} sent part of the work to ${to}.`
    case 'escalated': return `${from} raised something with ${to}.`
    case 'reported': return `${from} reported back to ${to}.`
    default: return `${from} handed the work to ${to}.`
  }
}

/** What the timeline says at `at`: the latest stitch at or before it, else who is working. */
export function momentAt(weft: Weft, at: number): { sentence: string; code: string | null; evidenceId: string | null; bad: boolean } {
  const stitch = [...weft.stitches].reverse().find((item) => item.at <= at)
  const knot = [...weft.knots].reverse().find((item) => item.at <= at)
  const nameOf = (id: string) => weft.lanes.find((lane) => lane.id === id)?.name ?? id
  if (knot && (!stitch || knot.at >= stitch.at)) {
    return { sentence: knotSentence(knot, nameOf(knot.from), weft.lanes.find((lane) => lane.id === knot.to)?.operator ? 'you' : nameOf(knot.to)), code: knot.relation === 'handed off to' ? 'handoff' : `delegation · ${knot.relation}`, evidenceId: null, bad: false }
  }
  if (stitch) return { sentence: stitch.sentence, code: stitch.code, evidenceId: stitch.evidenceId, bad: stitch.bad }
  const working = weft.lanes.filter((lane) => lane.start !== null && lane.start <= at && (lane.end ?? 0) >= at)
  if (working.length > 0) return { sentence: `${working.map((lane) => lane.name).join(' and ')} ${working.length === 1 ? 'is' : 'are'} getting started.`, code: null, evidenceId: null, bad: false }
  return { sentence: 'The run is starting.', code: null, evidenceId: null, bad: false }
}

export function clock(msValue: number): string {
  const seconds = Math.max(0, Math.round(msValue / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** One line of the run told as a story; `at` lets the reader jump the timeline to it. */
export interface StoryBeat { at: number; text: string; bad: boolean }

function span(msValue: number): string {
  const seconds = Math.max(1, Math.round(msValue / 1000))
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`
  const minutes = Math.round(seconds / 60)
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

/** The receipt's counts, plus the tools it does not list: each tool once, by name. */
type Tally = WorkCount & { tools: number }

const COUNTED: [(tally: Tally) => number, string, string][] = [
  [(tally) => tally.skills, 'used one skill', 'used {n} skills'],
  [(tally) => tally.read.files, 'read one file', 'read {n} files'],
  [(tally) => tally.read.pages, 'opened one web page', 'opened {n} web pages'],
  [(tally) => tally.read.notes, 'retrieved one notebook entry', 'retrieved {n} notebook entries'],
  [(tally) => tally.searches, 'ran one search', 'ran {n} searches'],
  [(tally) => tally.changed, 'changed one file', 'changed {n} files'],
  [(tally) => tally.commands, 'ran one command', 'ran {n} commands'],
  [(tally) => tally.tools, 'used one tool', 'used {n} tools'],
]

/**
 * The timeline read aloud: who worked, for how long, what they did, where it went wrong and when
 * the work changed hands. Counted from the same stitches and knots the cloth draws — nothing is
 * paraphrased from what an agent said about itself — and judged as the receipt judges them
 * (lib/story/reads.ts): each thing once however many calls reached it, and a failed call told as
 * a failure only when nothing else the agent did got what it was after. Its stitch stays red.
 */
export function narrate(weft: Weft): StoryBeat[] {
  const beats: StoryBeat[] = []
  const ran = weft.lanes.filter((lane) => lane.start !== null).sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
  if (ran.length === 0) return [{ at: 0, text: 'Nothing has happened yet.', bad: false }]
  for (const lane of ran) {
    const start = lane.start ?? 0
    const length = (lane.end ?? start) - start
    if (lane.operator) {
      beats.push({ at: start, text: lane.live ? 'The team is waiting for your decision.' : `The team waited ${span(length)} for your decision.`, bad: false })
      continue
    }
    const mine = weft.stitches.filter((stitch) => stitch.laneId === lane.id)
    const calls = mine.map((stitch) => stitch.evidence)
    const tools = new Set(calls.filter((item) => item.kind === 'tool' && item.status === 'succeeded').map((item) => item.name.split('\n')[0].trim())).size
    const tally: Tally = { ...workCount(calls), tools }
    const did = COUNTED.map(([counted, one, many]) => {
      const count = counted(tally)
      return count === 0 ? null : count === 1 ? one : many.replace('{n}', String(count))
    }).filter(Boolean) as string[]
    const list = did.length > 1 ? `${did.slice(0, -1).join(', ')} and ${did.at(-1)}` : did[0]
    const doing = did.length === 0 ? '' : did.length === 1 ? `, and ${list}` : `: it ${list}`
    beats.push({ at: start, text: lane.live ? `${lane.name} is working${list ? ` — so far it ${list}` : ''}.` : `${lane.name} worked for ${span(length)}${doing}.`, bad: false })
    // A failed call the agent made up for, such as a folder read as a file before the files in it,
    // is not told as a failure. A refused request still is: the receipt lists those apart.
    const missed = new Set<Evidence>(failuresOf(calls))
    const failed = mine.filter((stitch) => missed.has(stitch.evidence) || (stitch.bad && stitch.kind === 'permission'))
    if (failed.length === 1) beats.push({ at: failed[0].at, text: `${failed[0].sentence.replace(/\.$/, '')} — the run carried on.`, bad: true })
    else if (failed.length > 1) {
      // "News Collector couldn't open x." → "it couldn't open x", and "News Collector’s search for x
      // failed." → "its search for x failed", so the name is said once.
      const sentence = failed[0].sentence.replace(/\.$/, '')
      const first = sentence.startsWith(`${lane.name} `) ? `it ${sentence.slice(lane.name.length + 1)}` : sentence.startsWith(`${lane.name}’s `) ? `its ${sentence.slice(lane.name.length + 3)}` : sentence
      beats.push({ at: failed[0].at, text: `${failed.length} of ${lane.name}’s calls failed — first ${first}.`, bad: true })
    }
    for (const knot of weft.knots.filter((candidate) => candidate.from === lane.id)) {
      const next = weft.lanes.find((candidate) => candidate.id === knot.to)
      if (next) beats.push({ at: knot.at, text: knotSentence(knot, lane.name, next.operator ? 'you' : next.name), bad: false })
    }
  }
  if (!weft.live) beats.push({ at: weft.duration, text: `The run ended after ${span(weft.duration)}.`, bad: false })
  // A story is told in order: overlapping helpers interleave by time (stable for equal times).
  return beats.map((beat, index) => ({ beat, index })).sort((a, b) => a.beat.at - b.beat.at || a.index - b.index).map(({ beat }) => beat)
}
