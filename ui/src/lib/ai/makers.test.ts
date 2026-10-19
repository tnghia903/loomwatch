import { describe, expect, it } from 'vitest'

import { makerOf, sourceMaker } from './makers'

describe('makerOf', () => {
  it('names the company that made a model, with its mark', () => {
    const anthropic = makerOf('anthropic/claude-opus-5.5')
    expect(anthropic.name).toBe('Anthropic')
    expect(anthropic.mark?.length).toBeGreaterThan(0)
    expect(makerOf('z-ai/glm-5.3').name).toBe('Z.ai')
    expect(makerOf('meta-llama/llama-4').mark).toBe(makerOf('meta/muse-wonder').mark)
  })

  it('reads OpenRouter’s always-the-latest alias as the same maker', () => {
    expect(makerOf('~deepseek/deepseek-pro-latest')).toEqual(makerOf('deepseek/deepseek-v4-pro'))
  })

  it('shows a company in its own colours where it has a colour mark, and in one colour where it doesn’t', () => {
    // Anthropic has no colour mark of its own: its models' Claude mark is the one people know.
    expect(makerOf('anthropic/claude-opus-5.5').colour?.svg).toContain('#D97757')
    expect(makerOf('google/gemini-3-pro').colour?.svg).toContain('#4285F4')
    // OpenRouter's own brand glyphs: Grape on light, Volt on dark.
    expect(makerOf('openrouter/auto').colour).toMatchObject({ svg: expect.stringContaining('#7624F4'), dark: expect.stringContaining('#C8FF00') })
    // OpenAI's and xAI's marks are one colour, as they draw them.
    expect(makerOf('openai/gpt-5.5').colour).toBeUndefined()
    expect(makerOf('x-ai/grok-5').colour).toBeUndefined()
    expect(makerOf('openai/gpt-5.5').mark?.length).toBeGreaterThan(0)
    // A company with only a colour mark still gets it.
    expect(makerOf('microsoft/phi-5').colour?.svg).toContain('#F25022')
  })

  it('gives a maker it has no mark for its name alone, and one it doesn’t know OpenRouter’s word', () => {
    expect(makerOf('thinkingmachines/tinker-1')).toEqual({ name: 'Thinking Machines' })
    expect(makerOf('acme/plain-1')).toEqual({ name: 'acme' })
    expect(makerOf('constructor/x')).toEqual({ name: 'constructor' })
  })
})

describe('sourceMaker', () => {
  it('marks each way of paying with its own company, OpenRouter with OpenRouter’s', () => {
    expect(sourceMaker('openrouter').name).toBe('OpenRouter')
    expect(sourceMaker('openrouter').mark).toBeDefined()
    expect(sourceMaker('openrouter').mark).not.toEqual(sourceMaker('anthropic').mark)
    // In its own colours where it has them, as a model of that maker shows.
    expect(sourceMaker('openrouter').colour).toEqual(makerOf('openrouter/auto').colour)
    expect(sourceMaker('anthropic').colour).toEqual(makerOf('anthropic/claude-opus-5.5').colour)
    expect(sourceMaker('anthropic').name).toBe('Anthropic')
    expect(sourceMaker('chatgpt').name).toBe('OpenAI')
  })
})
