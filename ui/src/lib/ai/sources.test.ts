import { describe, expect, it } from 'vitest'

import { suggestModel } from '../team-file/modelSuggestion'
import { mayMoveBetween } from '../team-file/useModelFollowing'
import type { AiStatus } from './client'
import { DEFAULT_MODEL, FAST_MODEL, modelForTier, tierOfModel } from './modelIds'
import { canRun, connectedSources } from './sources'

function status(connected: { openrouter?: boolean; anthropic?: boolean; chatgpt?: boolean; planUse?: boolean }): AiStatus {
  return {
    openrouter: { connected: connected.openrouter === true },
    anthropic: { connected: connected.anthropic === true },
    chatgpt: { available: true, connected: connected.chatgpt === true, planUse: connected.planUse ?? connected.chatgpt === true },
  }
}

describe('the sources an agent can run on', () => {
  it('counts a ChatGPT sign-in only when plan use was allowed', () => {
    expect(connectedSources(status({ openrouter: true, anthropic: true, chatgpt: true }))).toEqual(['chatgpt', 'anthropic', 'openrouter'])
    expect(connectedSources(status({ chatgpt: true, planUse: false }))).toEqual([])
  })

  it('lets a model run when its own source is connected, and the offline demo always', () => {
    const claudeOnly = status({ anthropic: true })
    expect(canRun('anthropic:claude-opus-5-5', claudeOnly)).toBe(true)
    expect(canRun('anthropic/claude-opus-5.5', claudeOnly)).toBe(false)
    expect(canRun('chatgpt:gpt-6.1-sol', claudeOnly)).toBe(false)
    expect(canRun('fake/offline', claudeOnly)).toBe(true)
  })
})

describe('modelForTier', () => {
  // The same cases as `a_tier_names_its_model_then_a_plan_that_offers_it_pays_else_openrouter`.
  it('names the tier’s model first, then a connected plan that offers it pays, else OpenRouter', () => {
    expect(modelForTier('strong', [])).toBe(DEFAULT_MODEL)
    expect(modelForTier('strong', ['openrouter'])).toBe(DEFAULT_MODEL)
    expect(modelForTier('strong', ['openrouter', 'chatgpt', 'anthropic'])).toBe('anthropic:claude-opus-5-5')
    expect(modelForTier('check', ['openrouter', 'chatgpt', 'anthropic'])).toBe('chatgpt:gpt-6.1-sol')
    // The ChatGPT plan doesn't offer Claude Opus: OpenRouter pays for it, not the plan's own model.
    expect(modelForTier('strong', ['openrouter', 'chatgpt'])).toBe(DEFAULT_MODEL)
    expect(modelForTier('check', ['openrouter', 'anthropic'])).toBe('openai/gpt-6.1-sol')
    expect(modelForTier('fast', ['openrouter'])).toBe(FAST_MODEL)
    // Nothing connected can run the first choice: the plan's own model for the tier stands in.
    expect(modelForTier('strong', ['chatgpt'])).toBe('chatgpt:gpt-6.1-sol')
    expect(modelForTier('check', ['anthropic'])).toBe('anthropic:claude-opus-5-5')
  })

  it('pays through a plan only for a model its list offers', () => {
    expect(modelForTier('strong', ['openrouter', 'anthropic'], { anthropic: ['anthropic:claude-sonnet-5-5'] })).toBe(DEFAULT_MODEL)
    expect(modelForTier('strong', ['openrouter', 'anthropic'], { anthropic: ['anthropic:claude-opus-5-5'] })).toBe('anthropic:claude-opus-5-5')
    expect(modelForTier('check', ['openrouter', 'chatgpt'], { chatgpt: ['chatgpt:gpt-6-luna'] })).toBe('openai/gpt-6.1-sol')
  })

  it('knows a tier by its model on any source', () => {
    expect(tierOfModel('anthropic:claude-opus-5-5')).toBe('strong')
    expect(tierOfModel('chatgpt:gpt-6-luna')).toBe('fast')
    expect(tierOfModel(DEFAULT_MODEL)).toBe('strong')
    expect(tierOfModel('z-ai/glm-5.3')).toBeNull()
  })
})

describe('a following agent', () => {
  it('may move onto a plan just connected and onto its tier’s first choice, never onto OpenRouter by itself', () => {
    expect(mayMoveBetween('anthropic/claude-opus-5.5', 'anthropic:claude-opus-5-5')).toBe(true)
    expect(mayMoveBetween('anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5')).toBe(true)
    expect(mayMoveBetween('chatgpt:gpt-6.1-sol', 'anthropic/claude-opus-5.5', 'strong')).toBe(false)
    expect(mayMoveBetween('anthropic:claude-opus-5-5', 'chatgpt:gpt-6.1-sol')).toBe(false)
    expect(mayMoveBetween('chatgpt:gpt-6.1-sol', 'chatgpt:gpt-6-luna')).toBe(true)
    // The plan's own model stood in for Claude Opus; the Claude credit, connected since, runs the first choice.
    expect(mayMoveBetween('chatgpt:gpt-6.1-sol', 'anthropic:claude-opus-5-5', 'strong')).toBe(true)
    expect(mayMoveBetween('chatgpt:gpt-6.1-sol', 'anthropic:claude-sonnet-5-5', 'strong')).toBe(false)
  })
})

describe('the suggestion across sources', () => {
  const writer = { id: 'writer', name: 'Writer', role: 'Write the final report from what you are handed.', model: '' }

  it('suggests the model first, then pays through a plan that offers it before OpenRouter', () => {
    expect(suggestModel({ agent: writer, sources: ['openrouter', 'anthropic'] }).model).toBe('anthropic:claude-opus-5-5')
    expect(suggestModel({ agent: writer, sources: ['openrouter', 'chatgpt'] }).model).toBe(DEFAULT_MODEL)
    expect(suggestModel({ agent: writer, sources: ['openrouter'] }).model).toBe(DEFAULT_MODEL)
    // With only the ChatGPT plan, the plan's strongest stands in, so the agent still runs.
    expect(suggestModel({ agent: writer, sources: ['chatgpt'] })).toMatchObject({ model: 'chatgpt:gpt-6.1-sol', tier: 'strong' })
  })

  it('checks on another maker than the work it checks, on any source', () => {
    const checker = { id: 'checker', name: 'Checker', role: 'Check the writer’s report.', model: '', checks: 'writer' }
    const onClaude = { ...writer, model: 'anthropic:claude-opus-5-5' }
    const suggested = suggestModel({ agent: checker, team: { agents: [onClaude, checker], responder: 'writer' }, sources: ['anthropic', 'chatgpt'] })
    expect(suggested.model).toBe('chatgpt:gpt-6.1-sol')
    // Only the Claude credit: Claude checks Claude, and the tier says GPT-6.1-Sol is the first choice.
    expect(suggestModel({ agent: checker, team: { agents: [onClaude, checker], responder: 'writer' }, sources: ['anthropic'] })).toMatchObject({ model: 'anthropic:claude-opus-5-5', tier: 'check', why: expect.stringContaining('none you’ve connected is') })
    // A check on OpenAI's work: Claude Opus is the first choice, wherever it runs.
    const onPlan = { ...writer, model: 'chatgpt:gpt-6.1-sol' }
    expect(suggestModel({ agent: checker, team: { agents: [onPlan, checker], responder: 'writer' }, sources: ['chatgpt'] })).toMatchObject({ model: 'chatgpt:gpt-6.1-sol', tier: 'strong' })
  })
})
