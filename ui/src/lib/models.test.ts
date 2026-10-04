import { describe, expect, it } from 'vitest'

import type { DetectedHarness } from './harnesses'
import type { AgentConfig } from './team-file/types'
import { appLabelForAgent, harnessIdForAgent, modelOptionsForAgent } from './models'

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

  // The daemon pins the bridge version, and a saved team keeps the version it was saved with, so a
  // later pin must not turn an older team's agent into "Custom command: npx".
  it('recognises an npx bridge with or without a version, but not a lookalike package', () => {
    expect(harnessIdForAgent(agent('m', 'npx', ['-y', '@agentclientprotocol/claude-agent-acp@0.85.1']), [])).toBe('claude')
    expect(harnessIdForAgent(agent('m', 'npx', ['-y', '@agentclientprotocol/codex-acp@2.1.1']), [])).toBe('codex')
    expect(harnessIdForAgent(agent('m', 'npx', ['-y', '@agentclientprotocol/codex-acp']), [])).toBe('codex')
    expect(harnessIdForAgent(agent('m', 'npx', ['-y', '@agentclientprotocol/claude-agent-acp-fork']), [])).toBeNull()
  })
})

describe('appLabelForAgent', () => {
  // Field report (2026-10-04): the demo's cards said "AI app: Custom command: python3", which read
  // as if an AI app was involved. The bundled demo script is named for what it is.
  it('names the bundled offline demo as one, wherever its script is', () => {
    expect(appLabelForAgent(agent('fake/offline', 'python3', ['operator-stop-harness.py', 'writer']), [])).toBe('Offline demo (no AI)')
    expect(appLabelForAgent(agent('fake/offline', '/usr/bin/python3', ['/teams/operator-stop-harness.py', 'researcher']), [])).toBe('Offline demo (no AI)')
    expect(appLabelForAgent(agent('m', 'python3', ['my-agent.py']), [])).toBe('Custom command: python3')
    expect(appLabelForAgent(agent('claude-sonnet-5'), [])).toBe('Claude (not installed)')
    expect(appLabelForAgent({ id: 'review', name: 'You', role: 'Approve?', kind: 'operator' } as AgentConfig, [])).toBe('You (review step)')
  })
})
