import { describe, expect, it } from 'vitest'

import { DEFAULT_MODEL, FAST_MODEL } from '../ai/modelIds'
import type { AgentConfig } from '../team-file/types'
import { buildAgentFromSource, DEFAULT_AGENT_ROLE } from './createAgent'
import { ROLE_PRESETS, roleSource } from './roles'
import type { LibrarySource } from './types'

const blankSource: LibrarySource = {
  group: 'agents',
  id: 'blank',
  label: 'Agent',
}

const presetSource: LibrarySource = {
  group: 'presets',
  id: 'reviewer',
  label: 'Reviewer',
  role: 'Reviewer',
  model: 'anthropic/claude-haiku-5.5',
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'existing',
    name: 'Existing',
    role: 'Existing role',
    model: DEFAULT_MODEL,
    allowRecruiting: true,
    ...overrides,
  }
}

describe('buildAgentFromSource', () => {
  it('gives a blank agent a general role on the default model', () => {
    const result = buildAgentFromSource(blankSource, [])
    expect(result.role).toBe(DEFAULT_AGENT_ROLE)
    expect(result.model).toBe(DEFAULT_MODEL)
  })

  // ADR 0072: a team's own new agent follows the model suggested for it; one placed from Your agents
  // keeps the model its builder chose, and a review stop has no model at all.
  it('has a team’s own new agent follow its suggested model, and nothing else', () => {
    expect(buildAgentFromSource(blankSource, []).followsSuggestion).toBe(true)
    expect(buildAgentFromSource(presetSource, []).followsSuggestion).toBe(true)
    expect(buildAgentFromSource({ ...blankSource, from: { agent: 'scout', version: 2 } }, []).followsSuggestion).toBeUndefined()
    expect(buildAgentFromSource({ group: 'presets', id: 'you', label: 'You', kind: 'operator' } as LibrarySource, []).followsSuggestion).toBeUndefined()
  })

  it('pre-fills role and model from a preset source', () => {
    const result = buildAgentFromSource(presetSource, [])
    expect(result.role).toBe('Reviewer')
    expect(result.model).toBe('anthropic/claude-haiku-5.5')
  })

  // ADR 0037: the Researcher job brings its web switch; a blank agent brings none. ADR 0057: it
  // gathers on the faster model.
  it('places the Researcher job allowed to search the web, on the faster model, and a blank agent allowed nothing', () => {
    const researcher = ROLE_PRESETS.find((preset) => preset.id === 'researcher')!
    const placed = buildAgentFromSource(roleSource(researcher), [])
    expect(placed).toMatchObject({ allow: { web: true }, model: FAST_MODEL, thinkingEffort: 'medium' })
    expect(buildAgentFromSource(blankSource, []).allow).toBeUndefined()
    // The Checker opens the sources the work cites (ADR 0062); no other job starts with a switch on.
    expect(ROLE_PRESETS.filter((preset) => preset.allow).map((preset) => preset.id)).toEqual(['researcher', 'checker'])
  })

  it('works in the team file’s own folder, so it has no spawn', () => {
    expect(buildAgentFromSource(blankSource, [])).not.toHaveProperty('spawn')
  })

  it('slugifies the label into the id', () => {
    const result = buildAgentFromSource({ ...blankSource, label: 'Protocol Researcher' }, [])
    expect(result.id).toBe('protocol-researcher')
  })

  it('falls back to "agent" when the label has no alphanumerics', () => {
    const result = buildAgentFromSource({ ...blankSource, label: '·' }, [])
    expect(result.id).toBe('agent')
  })

  it('disambiguates a colliding id with a numeric suffix', () => {
    const result = buildAgentFromSource(blankSource, [
      agent({ id: 'agent' }),
      agent({ id: 'agent-2' }),
    ])
    expect(result.id).toBe('agent-3')
  })

  // Budgets are retired: a new agent carries no spend limit, whatever its source or neighbours.
  it('writes no budget into the new agent', () => {
    expect(buildAgentFromSource(blankSource, [])).not.toHaveProperty('budget')
    expect(buildAgentFromSource(presetSource, [agent({ id: 'a' })])).not.toHaveProperty('budget')
  })

  it('always sets allowRecruiting true and never writes status', () => {
    const result = buildAgentFromSource(blankSource, [])
    expect(result.allowRecruiting).toBe(true)
    expect(result.status).toBeUndefined()
  })
})
