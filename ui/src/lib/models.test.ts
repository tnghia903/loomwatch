import { describe, expect, it } from 'vitest'

import type { DetectedHarness } from './harnesses'
import type { AgentConfig } from './team-file/types'
import { harnessIdForAgent, modelOptionsForAgent } from './models'

function agent(model: string, cmd = 'npx', args = ['-y', '@agentclientprotocol/claude-agent-acp']): AgentConfig {
  return { id: model || 'empty', name: 'Agent', role: 'Work', model, spawn: { cmd, args, env: {}, cwd: '.' } }
}

describe('modelOptionsForAgent', () => {
  it('recognises an npx ACP bridge and preserves the configured model', () => {
    const target = agent('claude-sonnet-5')
    expect(harnessIdForAgent(target, [])).toBe('claude')
    expect(modelOptionsForAgent(target, [target], [])).toEqual([{ id: 'claude-sonnet-5', name: 'claude-sonnet-5', thinkingEfforts: [] }])
  })

  it('prefers models discovered from the live harness and keeps existing custom values', () => {
    const target = agent('company/custom-claude')
    const harness: DetectedHarness = {
      id: 'claude', name: 'Claude', command: 'claude', executablePath: '/bin/claude', acpAvailable: true,
      spawn: { cmd: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] },
    }
    expect(modelOptionsForAgent(target, [target], [harness], [
      { id: 'claude-live', name: 'Claude Live', thinkingEfforts: [] },
      { id: 'claude-next', name: 'Claude Next', thinkingEfforts: [] },
    ])).toEqual([
      { id: 'claude-live', name: 'Claude Live', thinkingEfforts: [] },
      { id: 'claude-next', name: 'Claude Next', thinkingEfforts: [] },
      { id: 'company/custom-claude', name: 'company/custom-claude', thinkingEfforts: [] },
    ])
  })

  it('learns choices already used by another agent on an unknown harness', () => {
    const target = agent('local/model-a', 'custom-acp', [])
    const peer = agent('local/model-b', 'custom-acp', [])
    expect(modelOptionsForAgent(target, [target, peer], [])).toEqual([
      { id: 'local/model-a', name: 'local/model-a', thinkingEfforts: [] },
      { id: 'local/model-b', name: 'local/model-b', thinkingEfforts: [] },
    ])
  })
})

describe('harnessIdForAgent', () => {
  // The daemon defaults a missing `spawn.args` to none, so a team file may leave it out.
  it('reads a spawn without args as no args, for a detected harness and for the fallbacks', () => {
    const opencode: DetectedHarness = {
      id: 'opencode', name: 'OpenCode', command: 'opencode', executablePath: '/bin/opencode', acpAvailable: true,
      spawn: { cmd: 'opencode', args: ['acp'] },
    }
    const hermes: DetectedHarness = { ...opencode, id: 'hermes', name: 'Hermes', command: 'hermes-acp', spawn: { cmd: 'hermes-acp', args: [] } }
    const bare = (cmd: string) => ({ ...agent('m', cmd), spawn: { cmd, cwd: '.' } }) as unknown as AgentConfig
    expect(harnessIdForAgent(bare('hermes-acp'), [opencode, hermes])).toBe('hermes')
    expect(harnessIdForAgent(bare('opencode'), [opencode, hermes])).toBe('opencode')
    expect(harnessIdForAgent(bare('loomwatchd'), [opencode])).toBeNull()
    expect(harnessIdForAgent(bare('npx'), [opencode])).toBeNull()
  })
})
