import { OFFLINE_MODEL, canonicalModel, modelNameFromId, parseModelRef } from './ai/modelIds'
import { SOURCE_INFO } from './ai/sources'
import type { AgentConfig } from './team-file/types'

/**
 * What runs this agent, in words: "Claude Opus 5.5", "You (review step)" or "Offline demo (no AI)".
 * `names` is the model list's own names by id, when it has arrived.
 */
export function modelLabelForAgent(agent: AgentConfig, names?: ReadonlyMap<string, string>): string {
  if (agent.kind === 'operator') return 'You (review step)'
  const id = canonicalModel(agent.model)
  if (id === OFFLINE_MODEL) return 'Offline demo (no AI)'
  const name = names?.get(id) ?? modelNameFromId(id)
  // A model a plan pays for says so on the card, so how an agent is paid shows at a glance (ADR 0073).
  const source = parseModelRef(id).source
  return source === 'openrouter' ? name : `${name} · ${SOURCE_INFO[source].chip}`
}

const THINKING_EFFORTS = new Set(['default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

export function splitModelSelector(selector: string): { modelId: string; thinkingEffort?: string } {
  const match = /^(.*)\[([^\]]+)\]$/.exec(selector.trim())
  if (!match || !THINKING_EFFORTS.has(match[2])) return { modelId: selector.trim() }
  return { modelId: match[1], thinkingEffort: match[2] }
}
