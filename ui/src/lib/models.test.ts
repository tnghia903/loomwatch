import { describe, expect, it } from 'vitest'

import type { AgentConfig } from './team-file/types'
import { modelLabelForAgent, splitModelSelector } from './models'

const agent = (model?: string): AgentConfig => ({ id: 'a', name: 'Agent', role: 'Work', ...(model === undefined ? {} : { model }) })

describe('modelLabelForAgent', () => {
  it('names the model an agent runs on, the review step and the offline demo', () => {
    expect(modelLabelForAgent(agent('anthropic/claude-haiku-5.5'))).toBe('Claude Haiku 5.5')
    expect(modelLabelForAgent({ id: 'review', kind: 'operator', name: 'You', role: 'Check it' })).toBe('You (review step)')
    expect(modelLabelForAgent(agent('fake/offline'))).toBe('Offline demo (no AI)')
  })

  it('reads a name written for an AI app as the model it maps to, and an empty one as the default', () => {
    expect(modelLabelForAgent(agent('sonnet'))).toBe('Claude Sonnet 5.5')
    expect(modelLabelForAgent(agent())).toBe('Claude Opus 5.5')
  })

  it('uses the model list’s own name once it has arrived', () => {
    expect(modelLabelForAgent(agent('openai/gpt-6.1-sol'), new Map([['openai/gpt-6.1-sol', 'GPT-6.1 Sol (OpenAI)']]))).toBe('GPT-6.1 Sol (OpenAI)')
  })
})

describe('splitModelSelector', () => {
  it('splits an effort written in brackets off the model', () => {
    expect(splitModelSelector('gpt-5.5[high]')).toEqual({ modelId: 'gpt-5.5', thinkingEffort: 'high' })
    expect(splitModelSelector('claude-opus-5-5[1m]')).toEqual({ modelId: 'claude-opus-5-5[1m]' })
  })
})
