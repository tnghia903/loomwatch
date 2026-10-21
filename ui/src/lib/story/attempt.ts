/**
 * One recorded call, read the way its panel tells it to someone who has never opened Terminal:
 * what the agent tried, how it went, why it didn't work, and what the agent did next. The exact
 * call stays in the panel's technical details; nothing here is shown in its place unless the record
 * says it.
 */

import type { Evidence } from '../watch/events'
import { commandOf, commandPlan, type CommandPlan } from './commands'
import { mendOf, type Mend } from './reads'
import { describeEvidence } from './weft'
import { whyItFailed, type Why } from './why'

/**
 * How it went. `fixed`: it failed and the agent got there another way; `unclear`: it failed and
 * its output doesn't say why; `answered`: you answered in its place; `waiting`: it is asking you.
 */
export type Outcome = 'worked' | 'fixed' | 'failed' | 'unclear' | 'declined' | 'answered' | 'allowed' | 'waiting' | 'working'

export interface Attempt {
  /** What the agent tried, as it went: "Coby couldn’t fetch 2 web pages". */
  sentence: string
  outcome: Outcome
  /** What it reached for, when the sentence doesn't name it. */
  targets: CommandPlan['targets']
  /** Why it didn't work, for a call that failed. */
  why: Why | null
  /** The call that got what this one was after. */
  mend: Mend<Evidence> | null
  /** What the agent did after a call that got it nothing: "Carried on without them". */
  then: string | null
}

const failed = (item: Pick<Evidence, 'status'>) => item.status === 'failed' || item.status === 'rejected'

import { outputText } from './webCalls'

export { outputText }

function outcomeOf(item: Evidence, why: Why | null, mend: Mend<Evidence> | null): Outcome {
  if (item.declined === 'answered') return 'answered'
  if (item.declined === 'denied' || why?.text === 'You said no.') return 'declined'
  if (item.kind === 'permission') return failed(item) ? 'declined' : item.status === 'succeeded' ? 'allowed' : 'waiting'
  if (item.status === 'succeeded') return 'worked'
  if (!failed(item)) return 'working'
  if (mend) return 'fixed'
  return why?.known ? 'failed' : 'unclear'
}

/** A command's sentence, by how it went: "couldn’t fetch", "fetched", "is fetching", "didn’t fetch". */
function commandSentence(agent: string, plan: CommandPlan, outcome: Outcome): string {
  const [base, past, ing] = plan.verb
  switch (outcome) {
    case 'worked': return `${agent} ${past} ${plan.object}`
    case 'working': return `${agent} is ${ing} ${plan.object}`
    case 'declined': case 'answered': return `${agent} didn’t ${base} ${plan.object}`
    default: return `${agent} couldn’t ${base} ${plan.object}`
  }
}

/** A message to a teammate that didn't get through, by what it was for: "Writer couldn’t ask Researcher". */
const TEAM_VERBS: Record<string, string> = { asked: 'ask', 'handed off to': 'hand work to', dispatched: 'send work to', escalated: 'escalate to', reported: 'report to' }
function teamSentence(agent: string, item: Evidence, outcome: Outcome): string | null {
  const verb = TEAM_VERBS[item.relation]
  if (item.kind !== 'delegation' || !item.target || !verb || !['failed', 'unclear'].includes(outcome)) return null
  return `${agent} couldn’t ${verb} ${item.target}`
}

/** The web search LoomWatch's engine runs, titled "Search the web: …". */
function webSearch(agent: string, item: Evidence, outcome: Outcome): string | null {
  const query = /^Search the web:\s*(.+)$/.exec(item.name.split('\n')[0])?.[1]
  if (!query) return null
  return ['failed', 'unclear', 'fixed'].includes(outcome) ? `${agent} couldn’t search the web for “${query}”` : `${agent} searched the web for “${query}”`
}

/**
 * `agent` is the agent's name; `calls` are the same agent's calls in record order, which tell a
 * failure it made up for, and whether it went on after one it didn't.
 */
export function readAttempt(agent: string, item: Evidence, calls: readonly Evidence[]): Attempt {
  const output = failed(item) ? outputText(item) : ''
  const why = failed(item) && !item.declined ? whyItFailed(output, item.kind) : null
  const mend = failed(item) && item.kind !== 'permission' ? mendOf(item, calls) : null
  const outcome = outcomeOf(item, why, mend)
  const plan = item.kind === 'command' ? commandPlan(commandOf(item)) : null
  const sentence = plan ? commandSentence(agent, plan, outcome) : teamSentence(agent, item, outcome) ?? webSearch(agent, item, outcome) ?? describeEvidence(agent, item).replace(/\.$/, '')
  const targets = plan?.targets ?? null
  // A call that got the agent nothing, followed by more work: it went on without what it was after.
  const missed = ['failed', 'unclear', 'declined', 'answered'].includes(outcome)
  const after = calls.some((call) => call.seq > item.seq)
  const without = item.kind === 'delegation' ? 'an answer' : (targets?.items.length ?? 0) > 1 ? 'them' : 'it'
  return {
    sentence,
    outcome,
    targets,
    why: why && ['failed', 'unclear', 'fixed'].includes(outcome) ? why : null,
    mend,
    then: missed && after ? `Carried on without ${without}` : null,
  }
}
