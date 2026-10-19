import { describe, expect, it } from 'vitest'

import tiers from '../../../../schemas/model-tiers.json'
import { BLANK_DRAFT } from '../library/draft'
import { buildAgentFromSource } from '../library/createAgent'
import { ROLE_PRESETS } from '../library/roles'
import { CHECK_MODEL, DEFAULT_MODEL, FAST_MODEL, jobNeeds, modelForJob, modelNameFromId, modelOn, modelSelector, NEW_AGENT, normalizeModel, openRouterEquivalent, openRouterId, parseModelRef } from './modelIds'
import { makerOf } from './makers'

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

describe('parseModelRef', () => {
  // The same cases as `a_model_says_where_it_is_paid` in the daemon's ai/models.rs.
  it.each([
    ['chatgpt:gpt-6.1-sol', 'chatgpt', 'gpt-6.1-sol'],
    ['ChatGPT: gpt-6-luna ', 'chatgpt', 'gpt-6-luna'],
    ['anthropic:claude-opus-5-5', 'anthropic', 'claude-opus-5-5'],
    ['chatgpt:', 'chatgpt', ''],
    ['anthropic:claude-opus-5-5[high]', 'anthropic', 'claude-opus-5-5'],
    ['anthropic/claude-opus-5.5[max]', 'openrouter', 'anthropic/claude-opus-5.5'],
    ['claude-opus-5-5[1m]', 'openrouter', 'anthropic/claude-opus-5.5'],
    ['anthropic/claude-opus-5.5', 'openrouter', 'anthropic/claude-opus-5.5'],
    ['openrouter:openai/gpt-6.1-sol', 'openrouter', 'openai/gpt-6.1-sol'],
    ['google/gemma-4-31b-it:free', 'openrouter', 'google/gemma-4-31b-it:free'],
    ['sonnet', 'openrouter', 'anthropic/claude-sonnet-5.5'],
    ['', 'openrouter', DEFAULT_MODEL],
  ])('reads %s as %s %s', (given, source, id) => {
    expect(parseModelRef(given)).toEqual({ source, id })
  })

  it('writes a model back as a team file does, its effort kept', () => {
    expect(modelSelector(parseModelRef('anthropic:claude-opus-5-5'))).toBe('anthropic:claude-opus-5-5')
    expect(normalizeModel('sonnet[high]')).toBe('anthropic/claude-sonnet-5.5[high]')
    expect(normalizeModel(' chatgpt:gpt-6.1-sol ')).toBe('chatgpt:gpt-6.1-sol')
  })

  // The same cases as `the_same_model_is_named_on_each_source`.
  it('names the same model on each source', () => {
    const claude = parseModelRef('anthropic/claude-opus-5.5')
    const direct = modelOn(claude, 'anthropic')
    expect(direct).toEqual({ source: 'anthropic', id: 'claude-opus-5-5' })
    expect(openRouterEquivalent(direct!)).toBe('anthropic/claude-opus-5.5')
    expect(modelOn(direct!, 'openrouter')).toEqual(claude)
    expect(modelOn(claude, 'chatgpt')).toBeUndefined()
    expect(modelOn(parseModelRef('openai/gpt-6.1-sol'), 'chatgpt')).toEqual({ source: 'chatgpt', id: 'gpt-6.1-sol' })
    expect(modelOn(parseModelRef('chatgpt:gpt-6.1-sol'), 'anthropic')).toBeUndefined()
    expect(modelOn(parseModelRef('anthropic/claude-opus-5.5:thinking'), 'anthropic')).toBeUndefined()
    expect(modelOn(parseModelRef('~anthropic/claude-opus-latest'), 'anthropic')).toBeUndefined()
  })

  it('names and marks a model a plan pays for by its maker', () => {
    expect(modelNameFromId('anthropic:claude-opus-5-5')).toBe('Claude Opus 5.5')
    expect(modelNameFromId('chatgpt:gpt-6.1-sol')).toBe('GPT-6.1 Sol')
    expect(makerOf('chatgpt:gpt-6.1-sol').name).toBe(makerOf('openai/gpt-6.1-sol').name)
    expect(makerOf('anthropic:claude-opus-5-5').name).toBe(makerOf('anthropic/claude-opus-5.5').name)
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
