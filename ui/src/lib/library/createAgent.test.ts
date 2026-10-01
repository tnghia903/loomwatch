import { describe, expect, it } from 'vitest'

import type { AgentConfig } from '../team-file/types'
import { buildAgentFromSource } from './createAgent'
import type { LibrarySource } from './types'

const harnessSource: LibrarySource = {
  group: 'detected',
  id: 'opencode',
  label: 'OpenCode',
  spawn: { cmd: 'opencode', args: ['acp'] },
}

const presetSource: LibrarySource = {
  group: 'presets',
  id: 'reviewer',
  label: 'Reviewer',
  role: 'Reviewer',
  model: 'claude-opus-5',
  budgetUsd: 5,
  spawn: { cmd: 'claude-agent-acp', args: [] },
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'existing',
    name: 'Existing',
    role: 'Existing role',
    model: 'existing/model',
    spawn: { cmd: 'opencode', args: ['acp'], env: {}, cwd: '.' },
    budget: { limitUsd: 12 },
    allowRecruiting: true,
    ...overrides,
  }
}

describe('buildAgentFromSource', () => {
  it('leaves role and model empty for a bare harness source', () => {
    const result = buildAgentFromSource(harnessSource, [])
    expect(result.role).toBe('')
    expect(result.model).toBe('')
  })

  it('pre-fills role and model from a preset source', () => {
    const result = buildAgentFromSource(presetSource, [])
    expect(result.role).toBe('Reviewer')
    expect(result.model).toBe('claude-opus-5')
  })

  it('copies spawn verbatim plus env and cwd defaults', () => {
    const result = buildAgentFromSource(harnessSource, [])
    expect(result.spawn).toEqual({ cmd: 'opencode', args: ['acp'], env: {}, cwd: '.' })
  })

  it('slugifies the label into the id', () => {
    const result = buildAgentFromSource(
      { ...harnessSource, label: 'Protocol Researcher' },
      [],
    )
    expect(result.id).toBe('protocol-researcher')
  })

  it('falls back to "agent" when the label has no alphanumerics', () => {
    const result = buildAgentFromSource({ ...harnessSource, label: '·' }, [])
    expect(result.id).toBe('agent')
  })

  it('disambiguates a colliding id with a numeric suffix', () => {
    const result = buildAgentFromSource(harnessSource, [
      agent({ id: 'opencode' }),
      agent({ id: 'opencode-2' }),
    ])
    expect(result.id).toBe('opencode-3')
  })

  it('defaults budget to $5 when there is no prior agent', () => {
    const result = buildAgentFromSource(harnessSource, [])
    expect(result.budget?.limitUsd).toBe(5)
  })

  it('inherits budget from the last-created agent, ignoring the preset’s own suggestion', () => {
    const result = buildAgentFromSource(presetSource, [agent({ id: 'a', budget: { limitUsd: 12 } })])
    expect(result.budget?.limitUsd).toBe(12)
  })

  it('always sets allowRecruiting true and never writes status', () => {
    const result = buildAgentFromSource(harnessSource, [])
    expect(result.allowRecruiting).toBe(true)
    expect(result.status).toBeUndefined()
  })
})
