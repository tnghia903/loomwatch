import type { ModelCatalog } from '../tiers'
import claude from './claude.json'

/**
 * Claude's catalog as it reads when its session runs on another model. `claude.json` was recorded
 * on Sonnet, so only Sonnet's efforts are known there. Switched to each model in the same session,
 * Claude answered Opus and `default` (its alias, "Opus 5.5") with the same Default to Max, and
 * Haiku 4.5 with no effort at all (`crates/loomwatch-backend/tests/fixtures/acp/`).
 */
export function claudeOn(id: 'opus' | 'default' | 'haiku'): ModelCatalog {
  const runsOn = id === 'haiku' ? ['haiku'] : ['default', 'opus']
  const efforts = id === 'haiku' ? [] : claude.models.find((model) => model.id === claude.currentModelId)?.thinkingEfforts ?? []
  return {
    models: claude.models.map((model) => runsOn.includes(model.id) ? { ...model, thinkingEfforts: efforts, effortsKnown: true } : { ...model, thinkingEfforts: [], effortsKnown: false }),
    currentModelId: id,
    currentThinkingEffort: id === 'haiku' ? undefined : claude.currentThinkingEffort,
  }
}
