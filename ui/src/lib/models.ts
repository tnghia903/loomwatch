import { OFFLINE_MODEL, canonicalModel, modelNameFromId } from './ai/modelIds'
import type { AgentConfig } from './team-file/types'

/**
 * What runs this agent, in words: "Claude Opus 5.5", "You (review step)" or "Offline demo (no AI)".
 * `names` is the model list's own names by id, when it has arrived.
 */
export function modelLabelForAgent(agent: AgentConfig, names?: ReadonlyMap<string, string>): string {
  if (agent.kind === 'operator') return 'You (review step)'
  const id = canonicalModel(agent.model)
  if (id === OFFLINE_MODEL) return 'Offline demo (no AI)'
  return names?.get(id) ?? modelNameFromId(id)
}

const THINKING_EFFORTS = new Set(['default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

export function splitModelSelector(selector: string): { modelId: string; thinkingEffort?: string } {
  const match = /^(.*)\[([^\]]+)\]$/.exec(selector.trim())
  if (!match || !THINKING_EFFORTS.has(match[2])) return { modelId: selector.trim() }
  return { modelId: match[1], thinkingEffort: match[2] }
}
