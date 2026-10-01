import { summarizeSchedule } from '../team-file/schedule'
import type { ScheduleConfig } from '../team-file/types'

/**
 * The team, said as one sentence.
 *
 * The canvas shows a team as boxes and wires, which reads well only to someone who already knows
 * what a configured edge or an entrypoint is. The same facts fit in a sentence a newcomer can check
 * at a glance — "When you ask, Researcher researches, then you approve, then Writer writes and
 * delivers the answer" — and a sentence that reads wrong is a team that is wired wrong, so it is
 * also a cheap review for someone who does know the vocabulary.
 *
 * Pure: it takes what the document already knows and returns parts, so the component can make the
 * agent names into buttons without parsing prose back out.
 */
export type SentencePart =
  | { kind: 'text'; text: string }
  | { kind: 'agent'; id: string; name: string; operator: boolean; title: string }
  | { kind: 'schedule'; text: string }
  | { kind: 'warning'; text: string }
  /** A one-click repair for what the sentence just said, as the edges it would add. */
  | { kind: 'fix'; text: string; connect: readonly { from: string; to: string }[] }

export interface SentenceAgent {
  id: string
  name: string
  role: string
  kind?: 'harness' | 'operator'
  model?: string
}

export interface SentenceInput {
  agents: readonly SentenceAgent[]
  edges: readonly { from: string; to: string }[]
  /** pipelineOrder() output: reachable stages first, disconnected ones appended. */
  steps: readonly { id: string; joinFrom: readonly string[] }[]
  entrypoint: string
  responder: string | null
  schedule?: Partial<ScheduleConfig> | null
}

/** First match wins; the words are what the agent's name or instructions say it does. The second
 * phrase is the same verb when that agent's stage is the last one, so the sentence can end on it. */
const VERBS: readonly [RegExp, string, string][] = [
  [/\b(collect|gather|scout|scrap)/, 'collects what is needed', 'collects what is needed and replies'],
  [/research|investigat|find\b|search/, 'researches', 'researches and replies'],
  [/\bedit/, 'edits', 'edits the answer'],
  [/review|check|verif|\bqa\b|audit|critic/, 'checks the work', 'checks the work and replies'],
  [/summar/, 'summarises', 'summarises it into the answer'],
  [/translat/, 'translates', 'translates the answer'],
  [/analy[sz]/, 'analyses', 'analyses it and replies'],
  [/design|visual|slide/, 'designs', 'designs the result'],
  [/\bplan|lead|orchestrat|coordinat/, 'plans', 'plans and replies'],
  [/\btest/, 'tests', 'tests it and replies'],
  [/cod(e|er|ing)\b|engineer|develop|implement|build|program/, 'builds', 'builds the result'],
  [/writ|draft|author|digest|report|copy/, 'writes', 'writes the answer'],
]

export function verbFor(agent: Pick<SentenceAgent, 'name' | 'role'>, final = false): string {
  // The name is the operator's own label and the more reliable signal, so it is tried first;
  // the role's opening sentence is the fallback.
  const name = agent.name.toLowerCase()
  const role = (agent.role.split(/(?<=[.!?])\s/)[0] ?? '').toLowerCase()
  for (const text of [name, role]) {
    const hit = VERBS.find(([pattern]) => pattern.test(text))
    if (hit) return final ? hit[2] : hit[1]
  }
  return final ? 'finishes the answer' : 'does its part'
}

/** "Daily at 8:00 AM" → "Every day at 8:00 AM"; a cron the editor cannot express stays raw. */
export function scheduleWords(schedule: Partial<ScheduleConfig>): string {
  const summary = summarizeSchedule(schedule)
  if (summary.startsWith('Daily at ')) return `Every day at ${summary.slice('Daily at '.length)}`
  if (summary.startsWith('Weekdays at ')) return `Every weekday at ${summary.slice('Weekdays at '.length)}`
  return `On its schedule (${summary})`
}

function reachableFrom(entrypoint: string, edges: SentenceInput['edges']): Set<string> {
  const seen = new Set<string>([entrypoint])
  const queue = [entrypoint]
  while (queue.length) {
    const current = queue.shift() as string
    for (const edge of edges) {
      if (edge.from === current && !seen.has(edge.to)) {
        seen.add(edge.to)
        queue.push(edge.to)
      }
    }
  }
  return seen
}

function list(names: SentencePart[]): SentencePart[] {
  if (names.length <= 1) return names
  const out: SentencePart[] = []
  names.forEach((part, index) => {
    if (index > 0) out.push({ kind: 'text', text: index === names.length - 1 ? ' and ' : ', ' })
    out.push(part)
  })
  return out
}

export function teamSentence(input: SentenceInput): SentencePart[] {
  const byId = new Map(input.agents.map((agent) => [agent.id, agent]))
  if (input.agents.length === 0 || !byId.has(input.entrypoint)) return []
  const ref = (id: string): SentencePart => {
    const agent = byId.get(id) as SentenceAgent
    const operator = agent.kind === 'operator'
    // Rule: plain name first, the real identifiers one hover away.
    const title = operator ? `${agent.id} · review step` : [agent.id, agent.model].filter(Boolean).join(' · ')
    return { kind: 'agent', id, name: operator ? 'you' : agent.name, operator, title }
  }
  const parts: SentencePart[] = []
  const scheduled = input.schedule && input.schedule.cron && input.schedule.enabled !== false
  if (scheduled) {
    parts.push({ kind: 'schedule', text: scheduleWords(input.schedule as Partial<ScheduleConfig>) })
    parts.push({ kind: 'text', text: ' and whenever you ask, ' })
  } else {
    parts.push({ kind: 'text', text: 'When you ask, ' })
  }

  const reachable = reachableFrom(input.entrypoint, input.edges)
  // Only a pipeline can strand an agent: in team mode nobody is wired and the lead recruits.
  const lonely = input.edges.length === 0 ? [] : input.agents.filter((agent) => !reachable.has(agent.id))

  if (input.edges.length === 0) {
    // Team mode: the entrypoint decides at run time who else it needs.
    const lead = ref(input.entrypoint)
    const others = input.agents.filter((agent) => agent.id !== input.entrypoint)
    if (others.length === 0) {
      parts.push(lead, { kind: 'text', text: ' does the whole task and replies' })
    } else {
      parts.push(lead, { kind: 'text', text: ' takes the request, brings in ' }, ...list(others.map((agent) => ref(agent.id))), { kind: 'text', text: ' when it needs help, and replies' })
    }
  } else {
    const ordered = input.steps.filter((step) => reachable.has(step.id))
    const last = ordered.length - 1
    ordered.forEach((step, index) => {
      const agent = byId.get(step.id)
      if (!agent) return
      const operator = agent.kind === 'operator'
      const isFinal = index === last
      if (index > 0) parts.push({ kind: 'text', text: isFinal ? ', and finally ' : ', then ' })
      if (operator) {
        parts.push(ref(step.id), { kind: 'text', text: isFinal ? ' approve the result' : ' approve or send it back' })
        return
      }
      parts.push(ref(step.id))
      if (step.joinFrom.length > 1) {
        parts.push({ kind: 'text', text: ' brings together ' })
        parts.push(...list(step.joinFrom.map((id) => ({ ...ref(id), name: byId.get(id)?.kind === 'operator' ? 'your' : `${byId.get(id)?.name}’s` }) as SentencePart)))
        parts.push({ kind: 'text', text: ` work and ${verbFor(agent, isFinal && index > 0)}` })
      } else {
        parts.push({ kind: 'text', text: ` ${verbFor(agent, isFinal && index > 0)}` })
      }
    })
  }

  const notion = input.schedule?.deliver && 'notion' in input.schedule.deliver
  parts.push({ kind: 'text', text: notion ? '. Scheduled answers go to Notion.' : '.' })
  if (input.responder && byId.has(input.responder) && input.edges.length > 0 && reachable.has(input.responder)) {
    const finalStep = input.steps.filter((step) => reachable.has(step.id)).at(-1)
    if (finalStep && finalStep.id !== input.responder) {
      parts.push({ kind: 'text', text: ' The answer you see comes from ' }, ref(input.responder), { kind: 'text', text: '.' })
    }
  }
  if (lonely.length > 0) {
    parts.push({ kind: 'text', text: ' ' })
    parts.push(...list(lonely.map((agent) => ref(agent.id))))
    parts.push({ kind: 'warning', text: lonely.length === 1 ? ' isn’t connected yet, so it won’t run.' : ' aren’t connected yet, so they won’t run.' })
    // The likely intent of placing a helper is "and then this one": offer to hang every stranded
    // agent off the end of the line, in the order they were added.
    const end = input.steps.filter((step) => reachable.has(step.id)).at(-1)?.id
    if (end) {
      const chain = [end, ...lonely.map((agent) => agent.id)]
      parts.push({ kind: 'fix', text: `Put ${lonely.length === 1 ? lonely[0].name : 'them'} after ${byId.get(end)?.kind === 'operator' ? 'your review' : byId.get(end)?.name}`, connect: chain.slice(1).map((to, index) => ({ from: chain[index], to })) })
    }
  } else if (input.edges.length === 0 && input.agents.length > 1) {
    // Team mode is a real choice (the lead recruits), but a newcomer who placed two helpers usually
    // meant a relay. Offer it, without assuming.
    const order = [input.entrypoint, ...input.agents.map((agent) => agent.id).filter((id) => id !== input.entrypoint)]
    parts.push({ kind: 'fix', text: 'Hand work along in this order instead', connect: order.slice(1).map((to, index) => ({ from: order[index], to })) })
  }
  return parts
}

/** The same sentence as plain text, for screen readers, copying and tests. */
export function sentenceText(parts: readonly SentencePart[]): string {
  return parts.filter((part) => part.kind !== 'fix').map((part) => (part.kind === 'agent' ? part.name : part.text)).join('')
}
