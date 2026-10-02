import { describe, expect, it } from 'vitest'

import type { AgentConfig } from '../team-file/types'
import { buildAgentFromSource, DEFAULT_AGENT_ROLE } from './createAgent'
import { ROLE_PRESETS, roleSource } from './roles'
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
  spawn: { cmd: 'claude-agent-acp', args: [] },
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'existing',
    name: 'Existing',
    role: 'Existing role',
    model: 'existing/model',
    spawn: { cmd: 'opencode', args: ['acp'], env: {}, cwd: '.' },
    allowRecruiting: true,
    ...overrides,
  }
}

describe('buildAgentFromSource', () => {
  it('gives a bare harness source a general role and leaves the model for the catalog', () => {
    const result = buildAgentFromSource(harnessSource, [])
    expect(result.role).toBe(DEFAULT_AGENT_ROLE)
    expect(result.model).toBe('')
  })

  it('pre-fills role and model from a preset source', () => {
    const result = buildAgentFromSource(presetSource, [])
    expect(result.role).toBe('Reviewer')
    expect(result.model).toBe('claude-opus-5')
  })

  // ADR 0037: the Researcher job brings its web switch; a bare app brings none.
  it('places the Researcher job allowed to search the web, and a bare app allowed nothing', () => {
    const researcher = ROLE_PRESETS.find((preset) => preset.id === 'researcher')
    const harness = { id: 'claude', name: 'Claude', command: 'claude', executablePath: '/bin/claude', acpAvailable: true, spawn: { cmd: 'npx', args: ['claude-agent-acp'] } }
    const source = researcher && roleSource(researcher, [harness])
    expect(source && buildAgentFromSource(source, []).allow).toEqual({ web: true })
    expect(buildAgentFromSource(harnessSource, []).allow).toBeUndefined()
    expect(ROLE_PRESETS.filter((preset) => preset.allow).map((preset) => preset.id)).toEqual(['researcher'])
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

  // Budgets are retired: a new agent carries no spend limit, whatever its source or neighbours.
  it('writes no budget into the new agent', () => {
    expect(buildAgentFromSource(harnessSource, [])).not.toHaveProperty('budget')
    expect(buildAgentFromSource(presetSource, [agent({ id: 'a' })])).not.toHaveProperty('budget')
  })

  it('always sets allowRecruiting true and never writes status', () => {
    const result = buildAgentFromSource(harnessSource, [])
    expect(result.allowRecruiting).toBe(true)
    expect(result.status).toBeUndefined()
  })
})
