// The three ways an agent's model is paid (ADR 0073), and how the app speaks of each. Each costs
// differently, so a model always shows which one it is on, and the plans a person already pays for
// come first.

import type { AiStatus, Catalog } from './client'
import { type ModelSource, OFFLINE_MODEL, type Offers, modelOn, modelSelector, parseModelRef } from './modelIds'

export interface SourceInfo {
  /** The model picker's section heading: "Your ChatGPT plan". */
  heading: string
  /** The short tag on a row, a button and an agent card: "ChatGPT plan". */
  chip: string
  /** How a call through it costs, in one plain line. */
  cost: string
  /** How a sentence names it: "on your ChatGPT plan". */
  on: string
  /** The service an agent's work is sent to: "ChatGPT". */
  service: string
  /** It is a plan the person already pays for, not pay per use. */
  subscription: boolean
}

export const SOURCE_INFO: Record<ModelSource, SourceInfo> = {
  chatgpt: {
    heading: 'Your ChatGPT plan',
    chip: 'ChatGPT plan',
    cost: 'Uses your Plus or Pro allowance. No extra charge; it stops at your plan’s limit.',
    on: 'on your ChatGPT plan',
    service: 'ChatGPT',
    subscription: true,
  },
  anthropic: {
    heading: 'Your Claude API credit',
    chip: 'Claude credit',
    cost: 'Paid from your Max or Team plan’s monthly API credit. Each call has a price.',
    on: 'on your Claude API credit',
    service: 'Claude',
    subscription: true,
  },
  openrouter: {
    heading: 'OpenRouter (pay per use)',
    chip: 'OpenRouter',
    cost: 'Paid from your OpenRouter credit. Each call has a price.',
    on: 'through OpenRouter',
    service: 'OpenRouter',
    subscription: false,
  },
}

/** Where ChatGPT shows the plan's usage and LoomWatch's share of it. */
export const CHATGPT_USAGE_PAGE = 'https://chatgpt.com/settings/usage'
/** Where the Claude Console shows the credit's balance. */
export const CLAUDE_BILLING_PAGE = 'https://platform.claude.com/settings/billing'

/** The sources an agent can run on now, plans first. */
export function connectedSources(status: AiStatus): ModelSource[] {
  const sources: ModelSource[] = []
  if (status.chatgpt.available && status.chatgpt.connected && status.chatgpt.planUse) sources.push('chatgpt')
  if (status.anthropic.connected) sources.push('anthropic')
  if (status.openrouter.connected) sources.push('openrouter')
  return sources
}

/** The models each connected plan offers, as selectors; a plan whose list isn't known yet is left out. */
export function offeredModels(status: AiStatus): Offers {
  const offers: Offers = {}
  if (status.anthropic.connected && status.anthropic.models) offers.anthropic = status.anthropic.models.map((model) => `anthropic:${model.id}`)
  if (status.chatgpt.connected && status.chatgpt.models) offers.chatgpt = status.chatgpt.models.map((model) => `chatgpt:${model.slug}`)
  return offers
}

/** Whether an agent on `model` can run now: its source is connected, or it is the offline demo. */
export function canRun(model: string | undefined, status: AiStatus): boolean {
  const reference = parseModelRef(model)
  if (reference.source === 'openrouter' && reference.id === OFFLINE_MODEL) return true
  return connectedSources(status).includes(reference.source)
}

/** The source `model` is paid through. */
export function sourceOf(model: string | undefined): ModelSource {
  return parseModelRef(model).source
}

/** A way of paying a team needs that isn't connected, and who needs it. */
export interface MissingSource {
  source: ModelSource
  /** The names of the agents whose models it pays for. */
  agents: string[]
  /** A connected source that has the same model for every one of them, to move them to in one click. */
  switchTo?: { source: ModelSource; models: { agentId: string; model: string }[] }
}

interface TeamAgent {
  id: string
  name: string
  model?: string
  kind?: string
}

/** Whether `source` lists `model`, as far as the app knows. OpenRouter lists every maker's. */
function lists(catalog: Catalog | null | undefined, source: ModelSource, model: string): boolean {
  if (!catalog) return source === 'openrouter'
  const list = source === 'chatgpt' ? catalog.chatgpt : source === 'anthropic' ? catalog.anthropic : catalog.models
  return (list ?? []).some((entry) => entry.id === model)
}

/**
 * The sources `agents` need that aren't connected (ADR 0073), each with who needs it and, when a
 * connected source has the same models, the move to it. Plans the person pays for are offered
 * first. Nothing is ever moved by itself: the person chooses.
 */
export function missingSources(agents: readonly TeamAgent[], status: AiStatus, catalog?: Catalog | null): MissingSource[] {
  const connected = connectedSources(status)
  const missing = new Map<ModelSource, TeamAgent[]>()
  for (const agent of agents) {
    if (agent.kind === 'operator' || canRun(agent.model, status)) continue
    const source = sourceOf(agent.model)
    missing.set(source, [...(missing.get(source) ?? []), agent])
  }
  return [...missing.entries()].map(([source, needing]) => {
    const switchTo = connected
      .map((target) => {
        const models = needing.map((agent) => ({ agentId: agent.id, model: modelOn(parseModelRef(agent.model), target) }))
        const all = models.every((entry) => entry.model && lists(catalog, target, modelSelector(entry.model)))
        return all ? { source: target, models: models.map((entry) => ({ agentId: entry.agentId, model: modelSelector(entry.model!) })) } : undefined
      })
      .find(Boolean)
    return { source, agents: needing.map((agent) => agent.name || agent.id), ...(switchTo ? { switchTo } : {}) }
  })
}

/** "Writer and Checker run on your ChatGPT plan, which isn't connected." and what to do about it. */
export function missingSourceSaid(missing: MissingSource): string {
  const [first, ...rest] = missing.agents
  const who = rest.length === 0 ? first : rest.length === 1 ? `${first} and ${rest[0]}` : `${first} and ${rest.length} others`
  const runs = missing.agents.length === 1 ? 'runs' : 'run'
  const what = `${who} ${runs} ${SOURCE_INFO[missing.source].on}, which isn’t connected.`
  if (missing.switchTo) return `${what} You can run ${missing.agents.length === 1 ? 'it' : 'them'} ${SOURCE_INFO[missing.switchTo.source].on} instead, or connect it on the Connections page.`
  if (missing.source === 'openrouter') return `${what} Add an OpenRouter key on the Connections page, or, if you have a Claude Max or Team plan or ChatGPT Plus or Pro, connect it there and choose its models.`
  return `${what} Connect it on the Connections page, or add an OpenRouter key and choose an OpenRouter model.`
}
