import { describe, expect, it } from 'vitest'

import { CHECK_MODEL, DEFAULT_MODEL, FAST_MODEL, modelForJob, modelNameFromId, openRouterId } from './modelIds'

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

describe('modelNameFromId', () => {
  it('names a model from its id until the list arrives', () => {
    expect(modelNameFromId('anthropic/claude-opus-5.5')).toBe('Claude Opus 5.5')
    expect(modelNameFromId('openai/gpt-6.1-sol')).toBe('GPT-6.1 Sol')
    expect(modelNameFromId('fake/offline')).toBe('Offline demo (no AI)')
  })
})
