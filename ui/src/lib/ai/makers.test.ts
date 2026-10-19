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
    expect(sourceMaker('anthropic').name).toBe('Anthropic')
    expect(sourceMaker('chatgpt').name).toBe('OpenAI')
  })
})
