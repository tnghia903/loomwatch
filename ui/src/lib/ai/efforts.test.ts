import { describe, expect, it } from 'vitest'

import type { AiStatus, Catalog } from './client'
import { effortWord, modelEfforts, placeEffort } from './efforts'

const ai: AiStatus = {
  openrouter: { connected: true },
  anthropic: {
    connected: true,
    models: [
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', contextLength: 1_000_000, maxOutput: 128_000, adaptiveThinking: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextLength: 200_000, maxOutput: 64_000, adaptiveThinking: false },
    ],
  },
  chatgpt: {
    available: true, connected: true, planUse: true,
    models: [
      { slug: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', contextLength: 500_000, efforts: ['ultra', 'low', 'medium', 'high', 'xhigh', 'max'] },
      { slug: 'gpt-6-luna', name: 'GPT-6-Luna', contextLength: 272_000, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    ],
  },
}
const model = (id: string, reasoning: boolean) => ({ id, name: id, contextLength: 1, inputPrice: 1, outputPrice: 1, free: false, reasoning })
const catalog: Catalog = { fetchedAt: '', defaultModel: 'acme/thinks', recommended: [], models: [model('acme/thinks', true), model('acme/plain', false)] }

describe('the efforts a model takes', () => {
  it('are the ones its ChatGPT plan or Claude key lists, least first', () => {
    expect(modelEfforts('chatgpt:gpt-6.1-sol', ai, catalog).levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(modelEfforts('chatgpt:gpt-6-luna', ai, catalog).levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(modelEfforts('anthropic:claude-opus-5-5', ai, catalog).levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('are the three for a plan model listed without efforts, as the daemon still sends the effort', () => {
    const quiet: AiStatus = { ...ai, chatgpt: { ...ai.chatgpt, models: [{ slug: 'gpt-6-nano', name: 'GPT-6-Nano', contextLength: 1 }] } }
    expect(modelEfforts('chatgpt:gpt-6-nano', quiet, catalog)).toMatchObject({ levels: ['low', 'medium', 'high'], listed: false })
  })

  it('are none for a listed Claude model with no effort setting, or one OpenRouter says doesn’t reason', () => {
    expect(modelEfforts('anthropic:claude-haiku-4-5', ai, catalog).levels).toEqual([])
    expect(modelEfforts('acme/plain', ai, catalog).levels).toEqual([])
  })

  it('are low, medium and high on OpenRouter, and until the source has answered', () => {
    expect(modelEfforts('acme/thinks', ai, catalog)).toMatchObject({ levels: ['low', 'medium', 'high'], listed: false })
    expect(modelEfforts('chatgpt:gpt-6-luna', null, null)).toMatchObject({ levels: ['low', 'medium', 'high'], listed: false })
    expect(modelEfforts('anthropic:claude-next', ai, catalog)).toMatchObject({ levels: ['low', 'medium', 'high'], listed: false })
  })
})

describe('where an effort sits on a model’s stops, and what is sent', () => {
  const luna = modelEfforts('chatgpt:gpt-6-luna', ai, catalog)
  const opus = modelEfforts('anthropic:claude-opus-5-5', ai, catalog)
  const openRouter = modelEfforts('acme/thinks', ai, catalog)
  // A small plan model whose list starts at medium.
  const mini = { ...luna, levels: ['medium', 'high'] }

  it('is its own stop when the model takes it', () => {
    expect(placeEffort('xhigh', luna)).toEqual({ stop: 'xhigh', runs: 'xhigh' })
    expect(placeEffort('ultra', modelEfforts('chatgpt:gpt-6.1-sol', ai, catalog))).toEqual({ stop: 'ultra', runs: 'ultra' })
    expect(placeEffort('', luna)).toEqual({ stop: '', runs: '' })
    expect(placeEffort('default', luna)).toEqual({ stop: '', runs: '' })
  })

  it('runs at the nearest one at or below that the model takes, as the daemon sends it', () => {
    expect(placeEffort('ultra', luna)).toEqual({ stop: 'max', runs: 'max', moved: 'nearest' })
    expect(placeEffort('ultra', opus)).toEqual({ stop: 'max', runs: 'max', moved: 'nearest' })
    // Claude reads none and minimal as low; the plan reads minimal as low.
    expect(placeEffort('none', opus)).toEqual({ stop: 'low', runs: 'low', moved: 'nearest' })
    expect(placeEffort('minimal', luna)).toEqual({ stop: 'low', runs: 'low', moved: 'nearest' })
  })

  it('is left to the model when nothing the model takes is at or below it', () => {
    expect(placeEffort('low', mini)).toEqual({ stop: '', runs: '', moved: 'nearest' })
    expect(placeEffort('minimal', mini)).toEqual({ stop: '', runs: '', moved: 'nearest' })
  })

  it('is sent past an end the stops don’t reach, as the source reads it', () => {
    expect(placeEffort('none', luna)).toEqual({ stop: 'low', runs: 'none', moved: 'below' })
    expect(placeEffort('max', openRouter)).toEqual({ stop: 'high', runs: 'max', moved: 'above' })
    // OpenRouter has no ultra: it goes as max.
    expect(placeEffort('ultra', openRouter)).toEqual({ stop: 'high', runs: 'max', moved: 'above' })
    expect(placeEffort('minimal', openRouter)).toEqual({ stop: 'low', runs: 'minimal', moved: 'below' })
    // A plan model whose list hasn't arrived gets the effort as set, but no ultra.
    expect(placeEffort('ultra', modelEfforts('chatgpt:gpt-6-luna', null, null))).toEqual({ stop: 'high', runs: 'max', moved: 'above' })
  })

  it('is left to the model for a word no source knows, or a model with no setting', () => {
    expect(placeEffort('turbo', luna)).toEqual({ stop: '', runs: '' })
    expect(placeEffort('high', modelEfforts('anthropic:claude-haiku-4-5', ai, catalog))).toEqual({ stop: '', runs: '' })
  })

  it('is named in plain words', () => {
    expect(effortWord('xhigh')).toBe('Extra high')
    expect(effortWord('max')).toBe('Max')
    expect(effortWord(undefined)).toBe('Model default')
  })
})
