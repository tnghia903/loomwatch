import { describe, expect, it } from 'vitest'

import { hasFastTier, modelTiers, onStrongTier, resolveModel, type ModelCatalog } from './tiers'
// Recorded on 2026-10-15 from `GET /api/harnesses/{id}/models` on a trial daemon: claude-agent-acp
// 0.85.1, codex-acp 2.1.1, OpenCode 1.18 (OpenRouter signed in) and Hermes, as their apps listed them.
import claude from './fixtures/claude.json'
import { claudeOn } from './fixtures/claudeOn'
import codex from './fixtures/codex.json'
import hermes from './fixtures/hermes.json'
import opencode from './fixtures/opencode.json'

const CATALOGS: Record<string, ModelCatalog> = { claude, codex, opencode, hermes }

/** The fast tier for `current` on an app, as `model` or `model[effort]`. */
function fast(catalog: ModelCatalog, current?: string): string {
  const tiers = modelTiers(catalog, current)
  if (!tiers) return 'none'
  return tiers.fast.thinkingEffort ? `${tiers.fast.model}[${tiers.fast.thinkingEffort}]` : tiers.fast.model
}

describe('model tiers', () => {
  it('makes the app’s current model the strong tier', () => {
    expect(modelTiers(claude)?.strong).toEqual({ model: 'sonnet' })
    expect(modelTiers(codex)?.strong).toEqual({ model: 'gpt-6.1-sol' })
    expect(modelTiers({ models: [] })).toBeNull()
  })

  it('steps Claude down one family by name, reading its default alias', () => {
    expect(fast(claude)).toBe('haiku')
    expect(fast(claude, 'opus')).toBe('sonnet')
    expect(resolveModel('default', claude.models)).toBe('opus')
    expect(fast(claude, 'default')).toBe('sonnet')
    // The family step reads the alias, not the first model described as fast.
    const pick = (...ids: string[]) => ids.map((id) => claude.models.find((model) => model.id === id) ?? { id, name: id, thinkingEfforts: [], effortsKnown: false })
    expect(fast({ models: pick('default', 'opus', 'haiku', 'sonnet') }, 'default')).toBe('sonnet')
    expect(fast(claude, 'claude-opus-5')).toBe('claude-sonnet-5')
    // No Opus 5.1 is listed under Fable 5.1, so it takes the model Claude itself calls efficient.
    expect(fast(claude, 'claude-fable-5-1')).toBe('sonnet')
  })

  it('takes the model Codex itself calls fast and affordable, never an older one', () => {
    expect(fast(codex)).toBe('gpt-6-luna')
    expect(fast(codex, 'gpt-5.6-terra')).toBe('gpt-6-luna')
    const olderFirst = { models: ['gpt-6.1-sol', 'gpt-5.6-luna', 'gpt-6-luna'].map((id) => codex.models.find((model) => model.id === id) ?? codex.models[0]) }
    expect(fast(olderFirst, 'gpt-6.1-sol')).toBe('gpt-6-luna')
  })

  it('works through OpenRouter, whose ids keep the vendor’s family names', () => {
    expect(fast(opencode, 'openrouter/anthropic/claude-opus-5.5')).toBe('openrouter/anthropic/claude-sonnet-5.5')
    expect(fast(opencode, 'openrouter/~anthropic/claude-opus-latest')).toBe('openrouter/~anthropic/claude-sonnet-latest')
    expect(fast(opencode, 'openrouter/openai/gpt-5.4')).toBe('openrouter/openai/gpt-5.4-mini')
    expect(fast(opencode, 'openrouter/openai/gpt-6.1-sol-pro')).toBe('openrouter/openai/gpt-6.1-sol')
    expect(fast(opencode, 'openrouter/google/gemini-2.5-pro')).toBe('openrouter/google/gemini-2.5-flash')
    expect(fast(hermes, 'anthropic:claude-opus-5-5')).toBe('anthropic:claude-sonnet-5-5')
    expect(fast(hermes, 'deepseek:deepseek-v4-pro')).toBe('deepseek:deepseek-v4-flash')
    expect(fast(hermes, 'openrouter:z-ai/glm-5.3')).toBe('openrouter:z-ai/glm-5.3-flash')
  })

  it('falls back to the lowest-but-one effort, only when it is below the app’s default', () => {
    expect(fast({ ...codex, currentThinkingEffort: 'high' }, 'gpt-6-luna')).toBe('gpt-6-luna[medium]')
    // Codex runs at medium, and 6 Luna's lowest-but-one is medium: nothing lighter.
    expect(fast(codex, 'gpt-6-luna')).toBe('gpt-6-luna')
    // Haiku 4.5 has no effort at all, so it has nothing lighter.
    expect(fast(claudeOn('haiku'))).toBe('haiku')
    expect(fast(claude, 'haiku')).toBe('haiku')
  })

  it('keeps the strong tier when the app lists nothing faster', () => {
    for (const [catalog, current] of [[opencode, undefined], [opencode, 'openrouter/openai/gpt-6.1-sol'], [hermes, undefined]] as const) {
      const tiers = modelTiers(catalog, current)
      expect(tiers && hasFastTier(tiers), current ?? catalog.currentModelId).toBe(false)
    }
  })

  it('never names a model its app did not list', () => {
    for (const [app, catalog] of Object.entries(CATALOGS)) {
      const listed = new Set(catalog.models.map((model) => model.id))
      for (const model of catalog.models) {
        const tiers = modelTiers(catalog, model.id)
        expect(listed.has(tiers?.fast.model ?? ''), `${app} ${model.id}`).toBe(true)
        const effort = tiers?.fast.thinkingEffort
        if (effort) expect(catalog.models.find((entry) => entry.id === tiers?.fast.model)?.thinkingEfforts.map((item) => item.id), `${app} ${model.id}`).toContain(effort)
      }
    }
  })

  it('says an agent is on the strong tier only on the strong model, above the fast tier’s effort', () => {
    const sonnet = modelTiers(claude)
    if (!sonnet) throw new Error('no tiers')
    expect(onStrongTier({ model: 'sonnet' }, sonnet, claude)).toBe(true)
    expect(onStrongTier({ model: 'sonnet[low]' }, sonnet, claude)).toBe(true)
    expect(onStrongTier({ model: 'haiku' }, sonnet, claude)).toBe(false)
    // A stronger model than the app's own is the operator's choice, not the strong tier.
    expect(onStrongTier({ model: 'opus' }, sonnet, claude)).toBe(false)

    const luna = { ...codex, currentModelId: 'gpt-6-luna', currentThinkingEffort: 'high' }
    const effortOnly = modelTiers(luna)
    if (!effortOnly) throw new Error('no tiers')
    expect(onStrongTier({ model: 'gpt-6-luna' }, effortOnly, luna)).toBe(true)
    expect(onStrongTier({ model: 'gpt-6-luna', thinkingEffort: 'high' }, effortOnly, luna)).toBe(true)
    expect(onStrongTier({ model: 'gpt-6-luna', thinkingEffort: 'medium' }, effortOnly, luna)).toBe(false)
    // The app did not say what it runs by default, so an agent with no effort cannot be judged.
    expect(onStrongTier({ model: 'gpt-6-luna' }, effortOnly, { ...luna, currentThinkingEffort: undefined })).toBe(false)
    // Haiku 4.5, Claude's smallest, has no effort: no faster tier to be above.
    const haiku = claudeOn('haiku')
    const none = modelTiers(haiku)
    if (!none) throw new Error('no tiers')
    expect(onStrongTier({ model: 'haiku' }, none, haiku)).toBe(false)
  })
})
