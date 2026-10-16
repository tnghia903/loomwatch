// Whether a run earned a quest's item (./catalog.ts), read only from what LoomWatch recorded: the
// run's record and projection, the team file it ran, and the team's own earlier runs. Nothing here
// trusts an agent's account of itself (RUN_PROVENANCE_CONTRACT.md §8.2), and nothing counts runs.
// Pure, like runLessons.ts: the receipt calls it for the run it shows.

import type { RunRecord } from '../runs/client'
import { readCount } from '../story/reads'
import type { LessonRun } from '../team-file/runLessons'
import type { AgentConfig, AllowSwitch } from '../team-file/types'
import type { RunProjection } from '../watch/events'
import { chosenIsFile } from '../knowledge/chosen'
import { AREAS, QUESTS, type QuestItem } from './catalog'

/** What a run earned: the item, the agent whose work earned it when one did, and what happened. */
export interface Award {
  item: QuestItem
  agentId: string | null
  /** One sentence on what this run did, in the receipt's words. */
  line: string
}

export interface QuestFacts {
  run: Pick<RunRecord, 'runId' | 'createdAt' | 'trigger' | 'onlyAgent' | 'startAt'>
  /** The run finished with its answer (`succeeded`, not `partial`): only a finished run earns. */
  succeeded: boolean
  /** The team file the run ran, as it is now. */
  agents: readonly AgentConfig[]
  projection: Pick<RunProjection, 'agents' | 'evidence' | 'messages' | 'checks'>
  /** This run reduced like the team's other runs (runLessons.ts `lessonRun`). */
  current: LessonRun
  /** The same team's whole-team runs before this one, newest first. */
  earlier: readonly LessonRun[]
  /** Agents in Your agents with a test bench run that finished before this run started. */
  benched: ReadonlySet<string>
}

const SWITCH_WORDS: Record<AllowSwitch, string> = { web: 'search the web', edits: 'change files', commands: 'run commands' }
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

function nameOf(agents: readonly AgentConfig[], id: string): string {
  return agents.find((agent) => agent.id === id)?.name ?? id
}

const clean = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '')

/** Whether a read of `read` reached into `given`: the folder itself or anything inside it. A path
    the team file keeps relative to its own folder is matched by its tail. */
function within(read: string, given: string): boolean {
  const folder = clean(given).replace(/^\.\//, '').replace(/^~\//, '')
  const path = clean(read)
  if (!folder) return false
  if (path === folder || path.startsWith(`${folder}/`)) return true
  return path.endsWith(`/${folder}`) || path.includes(`/${folder}/`)
}

/** Paths an agent read successfully, as the record names them. */
function readPaths(projection: QuestFacts['projection'], agentId: string): string[] {
  return projection.evidence
    .filter((item) => item.agentId === agentId && item.status === 'succeeded' && (item.relation === 'read file' || item.relation === 'searched'))
    .flatMap((item) => {
      const input = item.rawInput && typeof item.rawInput === 'object' ? (item.rawInput as Record<string, unknown>) : {}
      const named = ['path', 'file_path', 'filePath'].flatMap((key) => (typeof input[key] === 'string' ? [input[key] as string] : []))
      return [...item.locations.map((location) => location.path), ...named]
    })
}

/** Only a check step's verdict decides, as the daemon recorded it: an agent saying it met its Done
    when, or listing nothing under "Not met", is the agent's account of itself. Every check on its
    work has to have stopped at its first round (nothing sent back) with every verdict Met, and one
    of them has to give a verdict for every item. */
function chalk({ succeeded, agents, projection }: QuestFacts): Award | null {
  if (!succeeded) return null
  for (const agent of agents) {
    const count = agent.doneWhen?.length ?? 0
    if (count === 0) continue
    const rounds = (projection.checks ?? []).filter((candidate) => candidate.checked === agent.id && candidate.checker !== agent.id)
    if (!rounds.every((candidate) => candidate.round === 1 && candidate.items.every((item) => item.verdict === 'met'))) continue
    const round = rounds.find((candidate) => candidate.items.length >= count)
    if (!round) continue
    return { item: 'chalk', agentId: agent.id, line: `${nameOf(agents, round.checker)} checked ${agent.name}’s work and found all ${plural(count, 'item')} of its Done when met on the first pass.` }
  }
  return null
}

function band({ succeeded, agents, projection, current }: QuestFacts): Award | null {
  if (!succeeded) return null
  for (const agent of agents) {
    if (!current.agentIds.includes(agent.id)) continue
    const folders = (agent.capabilities ?? []).flatMap((capability) => (capability.kind === 'knowledge' && capability.path && !chosenIsFile(capability.path) ? [capability.path] : []))
    if (folders.length === 0) continue
    const paths = readPaths(projection, agent.id)
    if (!folders.every((folder) => paths.some((path) => within(path, folder)))) continue
    const files = readCount(projection.evidence.filter((item) => item.agentId === agent.id)).files
    return {
      item: 'band', agentId: agent.id,
      line: `${agent.name} was given ${plural(folders.length, 'folder')} and read from every one${files ? `, ${plural(files, 'file')} in all` : ''}.`,
    }
  }
  return null
}

function pin({ run, succeeded, agents, projection, current }: QuestFacts): Award | null {
  if (!succeeded || run.trigger !== 'schedule') return null
  if (projection.messages.some((message) => message.kind === 'permission' && !message.carried)) return null
  if (projection.evidence.some((item) => item.kind === 'permission')) return null
  const held: { agent: AgentConfig; key: AllowSwitch }[] = agents
    .filter((agent) => current.agentIds.includes(agent.id))
    .flatMap((agent) => (['web', 'edits', 'commands'] as AllowSwitch[]).filter((key) => agent.allow?.[key]).map((key) => ({ agent, key })))
  if (held.length === 0) return null
  const used = (agentId: string, key: AllowSwitch) => projection.evidence.some((item) => item.agentId === agentId && item.status === 'succeeded' && (
    key === 'web' ? item.kind === 'search' || item.relation === 'consulted source'
      : key === 'edits' ? item.kind === 'file' && item.relation !== 'read file'
        : item.kind === 'command'))
  if (!held.every(({ agent, key }) => used(agent.id, key))) return null
  const words = [...new Set(held.map(({ key }) => SWITCH_WORDS[key]))]
  return { item: 'pin', agentId: null, line: `This scheduled run never had to ask for a permission, and every key it held was used (${words.join(', ')}).` }
}

function cushion({ succeeded, agents, current, benched }: QuestFacts): Award | null {
  if (!succeeded) return null
  const agent = agents.find((candidate) => candidate.from && current.agentIds.includes(candidate.id) && benched.has(candidate.from.agent))
  return agent ? { item: 'cushion', agentId: agent.id, line: `${agent.name} was tried on its test bench before this team used it.` } : null
}

function shuttle({ succeeded, agents, projection }: QuestFacts): Award | null {
  if (!succeeded) return null
  const ask = projection.messages.find((message) => message.kind === 'ask' && !message.carried && message.state === 'answered' && message.from && message.to && message.from !== message.to)
  if (!ask?.from || !ask.to) return null
  return { item: 'shuttle', agentId: ask.from, line: `${nameOf(agents, ask.from)} asked ${nameOf(agents, ask.to)} a question over the Team Bus and got an answer.` }
}

function monocle({ succeeded, agents, projection }: QuestFacts): Award | null {
  if (!succeeded) return null
  const round = (projection.checks ?? []).find((candidate) => candidate.round >= 2 && candidate.items.length > 0 && candidate.items.every((item) => item.verdict === 'met'))
  if (!round) return null
  return {
    item: 'monocle', agentId: round.checker,
    line: `${nameOf(agents, round.checker)} sent ${nameOf(agents, round.checked)}’s work back once, and the second pass met all ${plural(round.items.length, 'item')} it checks.`,
  }
}

/** A habit the team's earlier runs showed (runLessons.ts reads the same ones), and this run did not. */
function patch({ succeeded, agents, current, earlier }: QuestFacts): Award | null {
  if (!succeeded) return null
  const recent = earlier.slice(0, 5)
  const work = (message: LessonRun['messages'][number]) => !message.carried && (message.kind === 'dispatch' || message.kind === 'ask' || message.kind === 'handoff')
  for (const agent of agents) {
    if (agent.kind === 'operator' || !current.agentIds.includes(agent.id)) continue
    const ranIn = recent.filter((run) => run.agentIds.includes(agent.id))
    // It stopped asking for the same permission.
    for (const key of ['web', 'edits', 'commands'] as AllowSwitch[]) {
      const asked = (run: LessonRun) => run.messages.some((message) => message.kind === 'permission' && !message.carried && message.from === agent.id && message.permission?.switch === key)
      const before = ranIn.filter(asked).length
      if (before >= 2 && !asked(current)) return { item: 'patch', agentId: agent.id, line: `${agent.name} asked to ${SWITCH_WORDS[key]} in ${before} recent runs, and didn’t need to this time.` }
    }
    // It stopped failing.
    const failures = ranIn.filter((run) => run.failed.has(agent.id)).length
    if (failures >= 2 && !current.failed.has(agent.id)) return { item: 'patch', agentId: agent.id, line: `${agent.name} failed in ${failures} recent runs, and finished its part this time.` }
  }
  // A lead that never handed a teammate anything now does.
  const lead = agents.find((agent) => agent.id === current.entrypoint)
  if (lead && current.mode === 'team') {
    for (const teammate of agents) {
      if (teammate.id === lead.id || teammate.kind === 'operator' || !current.agentIds.includes(teammate.id)) continue
      const together = recent.filter((run) => run.succeeded && run.mode === 'team' && run.entrypoint === lead.id && run.agentIds.includes(teammate.id))
      const idle = together.length >= 3 && together.every((run) => !run.messages.some((message) => work(message) && message.to === teammate.id))
      if (idle && current.messages.some((message) => work(message) && message.from === lead.id && message.to === teammate.id)) {
        return { item: 'patch', agentId: lead.id, line: `${lead.name} never gave ${teammate.name} any work in ${together.length} runs, and did this time.` }
      }
    }
  }
  // A later stage that kept asking an earlier one for more now gets it in the handover.
  if (current.mode === 'pipeline') {
    const asks = new Map<string, { from: string; to: string; count: number; runs: number }>()
    for (const run of recent.filter((candidate) => candidate.succeeded && candidate.mode === 'pipeline')) {
      const seen = new Set<string>()
      for (const message of run.messages) {
        if (message.carried || message.kind !== 'ask' || !message.from || !message.to) continue
        const key = `${message.from}>${message.to}`
        const entry = asks.get(key) ?? { from: message.from, to: message.to, count: 0, runs: 0 }
        entry.count += 1
        if (!seen.has(key)) { entry.runs += 1; seen.add(key) }
        asks.set(key, entry)
      }
    }
    for (const { from, to, count, runs } of asks.values()) {
      if (count < 3 || runs < 2 || !current.agentIds.includes(from) || !current.agentIds.includes(to)) continue
      if (current.messages.some((message) => !message.carried && message.kind === 'ask' && message.from === from && message.to === to)) continue
      return { item: 'patch', agentId: to, line: `${nameOf(agents, from)} kept asking ${nameOf(agents, to)} for more, and this time the handover was enough.` }
    }
  }
  return null
}

function totalTokens(run: LessonRun): number | null {
  const counts = [...run.usage.values()].flatMap((usage) => (usage.tokens === null ? [] : [usage.tokens]))
  return counts.length ? counts.reduce((sum, count) => sum + count, 0) : null
}

function scissors({ succeeded, current, earlier }: QuestFacts): Award | null {
  if (!succeeded) return null
  const last = earlier.find((run) => run.succeeded)
  if (!last || current.agentIds.length >= last.agentIds.length) return null
  const [now, before] = [totalTokens(current), totalTokens(last)]
  if (now === null || before === null || now >= before) return null
  const saved = Math.round((1 - now / before) * 100)
  return { item: 'scissors', agentId: null, line: `This team ran with ${plural(current.agentIds.length, 'agent')} instead of ${last.agentIds.length}, and used ${saved}% fewer tokens than its last run.` }
}

const RULES = [chalk, band, pin, cushion, shuttle, monocle, patch, scissors]

/** Everything this run earned, in the catalog's order. A one-agent turn or a follow-up that started
    part-way earns nothing: it is not the whole team at work. */
export function questsEarned(facts: QuestFacts): Award[] {
  if (facts.run.onlyAgent || facts.run.startAt) return []
  return RULES.flatMap((rule) => rule(facts) ?? [])
}

/** Bobbin: the wardrobe, with what this run earned, holds an item from every part. */
export function wholeCraft(held: Iterable<string>): boolean {
  const items = new Set(held)
  return AREAS.every((area) => QUESTS.some((quest) => quest.area === area && items.has(quest.item)))
}

export const BOBBIN_LINE = 'Your wardrobe now holds an item from each of the five parts of building agents.'
