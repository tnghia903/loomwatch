import { describe, expect, it } from 'vitest'

import tiers from '../../../../schemas/model-tiers.json'
import { BLANK_DRAFT } from '../library/draft'
import { buildAgentFromSource } from '../library/createAgent'
import { ROLE_PRESETS } from '../library/roles'
import { CHECK_MODEL, DEFAULT_MODEL, FAST_MODEL, jobNeeds, modelForJob, modelNameFromId, NEW_AGENT, openRouterId } from './modelIds'

describe('openRouterId', () => {
  // The same cases as `old_model_names_become_openrouter_ids` in the daemon's ai/models.rs.
  it.each([
    ['anthropic/claude-haiku-5.5', 'anthropic/claude-haiku-5.5'],
    ['openrouter/openai/gpt-6.1-sol', 'openai/gpt-6.1-sol'],
    ['openrouter:anthropic/claude-sonnet-5.5', 'anthropic/claude-sonnet-5.5'],
    ['fake/offline', 'fake/offline'],
    ['sonnet', 'anthropic/claude-sonnet-5.5'],
    ['opus', 'anthropic/claude-opus-5.5'],
    ['default', DEFAULT_MODEL],
    ['claude-sonnet-5-5', 'anthropic/claude-sonnet-5.5'],
    ['claude-opus-5-5[1m]', 'anthropic/claude-opus-5.5'],
    ['claude-haiku-4-5', 'anthropic/claude-haiku-4.5'],
    ['gpt-5.5', 'openai/gpt-5.5'],
    ['gemini-3.8-flash', 'google/gemini-3.8-flash'],
    ['', DEFAULT_MODEL],
    ['something-unknown', DEFAULT_MODEL],
  ])('reads %s as %s', (given, expected) => {
    expect(openRouterId(given)).toBe(expected)
  })
})

describe('modelForJob', () => {
  it('runs gathering on the faster model and thinks as hard as the job needs', () => {
    expect(modelForJob({ tier: 'fast', effort: 'standard' })).toEqual({ model: FAST_MODEL, thinkingEffort: 'medium' })
    expect(modelForJob({ tier: 'strong', effort: 'deep' })).toEqual({ model: DEFAULT_MODEL, thinkingEffort: 'high' })
    expect(modelForJob({ tier: 'check', effort: 'deep' })).toEqual({ model: CHECK_MODEL, thinkingEffort: 'high' })
    expect(modelForJob({})).toEqual({ model: DEFAULT_MODEL })
  })
})

// `schemas/model-tiers.json` is the one table: the daemon's Ask reads it too (ai/models.rs).
describe('the model table', () => {
  it('gives every built-in job and every new agent its model and effort', () => {
    expect([DEFAULT_MODEL, FAST_MODEL, CHECK_MODEL]).toEqual([tiers.models.strong, tiers.models.fast, tiers.models.check])
    for (const preset of ROLE_PRESETS) {
      expect({ tier: preset.tier, effort: preset.effort }).toEqual(jobNeeds(preset.id))
    }
    expect(Object.keys(tiers.jobs).sort()).toEqual(ROLE_PRESETS.map((preset) => preset.id).sort())
    expect(() => jobNeeds('juggler')).toThrow(/no job juggler/)
    // A blank agent, in the builder and on the canvas, starts as the table's new agent.
    const fresh = modelForJob(NEW_AGENT)
    expect(fresh).toEqual({ model: DEFAULT_MODEL, thinkingEffort: 'medium' })
    expect({ model: BLANK_DRAFT.model, effort: BLANK_DRAFT.effort }).toEqual({ model: fresh.model, effort: fresh.thinkingEffort })
    const dropped = buildAgentFromSource({ group: 'presets', id: 'blank', label: 'Agent' }, [])
    expect({ model: dropped.model, thinkingEffort: dropped.thinkingEffort }).toEqual(fresh)
    // A source that names its own model keeps it, and its own effort or none.
    const named = buildAgentFromSource({ group: 'presets', id: 'blank', label: 'Agent', model: 'z-ai/glm-5.3' }, [])
    expect({ model: named.model, thinkingEffort: named.thinkingEffort }).toEqual({ model: 'z-ai/glm-5.3', thinkingEffort: undefined })
  })
})

describe('modelNameFromId', () => {
  it('names a model from its id until the list arrives', () => {
    expect(modelNameFromId('anthropic/claude-opus-5.5')).toBe('Claude Opus 5.5')
    expect(modelNameFromId('openai/gpt-6.1-sol')).toBe('GPT-6.1 Sol')
    expect(modelNameFromId('fake/offline')).toBe('Offline demo (no AI)')
  })
})
