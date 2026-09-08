import { describe, expect, it } from 'vitest'

import type { TeamDocument } from './types'
import { compileTeamValidator, displayFieldProblems } from './validation'

// Represents the daemon-delivered contract for the inspector's editable fields. The validator
// itself accepts whatever full schema the daemon returns; this compact fixture keeps the tests
// concerned with the UI gate rather than duplicating schemas/team.schema.yaml in the bundle.
const daemonSchema = {
  type: 'object',
  required: ['schemaVersion', 'id', 'name', 'entrypoint', 'agents', 'edges'],
  properties: {
    schemaVersion: { const: 1 },
    id: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    entrypoint: { type: 'string', minLength: 1 },
    agents: {
      type: 'array', minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'name', 'role', 'spawn', 'model', 'budget'],
        properties: {
          id: { type: 'string', minLength: 1 },
          name: { type: 'string', minLength: 1 },
          role: { type: 'string', minLength: 1 },
          model: { type: 'string', minLength: 1 },
          spawn: { type: 'object', required: ['cwd'], properties: { cwd: { type: 'string', minLength: 1 } } },
          budget: { type: 'object', required: ['limitUsd'], properties: { limitUsd: { type: 'number', minimum: 0 } } },
        },
      },
    },
    edges: { type: 'array' },
  },
} as const

function document(overrides: Partial<TeamDocument> = {}): TeamDocument {
  return {
    schemaVersion: 1,
    id: 'research-team',
    name: 'Research team',
    entrypoint: 'researcher',
    agents: [{
      id: 'researcher', name: 'Researcher', role: 'Research', model: 'model-1',
      spawn: { cmd: 'agent', args: [], env: {}, cwd: '.' }, budget: { limitUsd: 5 },
    }],
    edges: [],
    ...overrides,
  }
}

describe('compileTeamValidator', () => {
  it('turns daemon schema failures for empty inspector fields into incomplete field problems', () => {
    const validate = compileTeamValidator(daemonSchema)
    const result = validate(document({ agents: [{ ...document().agents[0], role: '', model: '', spawn: { cmd: 'agent', args: [], env: {}, cwd: '' } }] }))

    expect(result.valid).toBe(false)
    expect(result.fieldProblemsByAgent.get('researcher')).toMatchObject({
      role: { weight: 'incomplete', message: 'Required' },
      model: { weight: 'incomplete', message: 'Required' },
      cwd: { weight: 'incomplete', message: 'Required' },
    })
  })

  it('applies TEAM_CONFIG semantic rules that the schema cannot express', () => {
    const validate = compileTeamValidator(daemonSchema)
    const result = validate(document({
      entrypoint: 'missing',
      budget: { limitUsd: Number.POSITIVE_INFINITY },
      agents: [{ ...document().agents[0], budget: { limitUsd: Number.NaN } }],
      edges: [{ from: 'researcher', to: 'researcher', layer: 'configured', kind: 'sequence', ts: '2026-09-08T00:00:00Z' }],
    }))

    expect(result.valid).toBe(false)
    expect(result.fieldProblemsByAgent.get('researcher')?.limitUsd).toMatchObject({ weight: 'error' })
    expect(result.documentProblems.map((problem) => problem.message)).toEqual(expect.arrayContaining([
      'Entrypoint `missing` does not name an agent in this team.',
      'Team budget must be a finite number.',
      '`researcher` can\'t follow itself.',
    ]))
  })
})

describe('displayFieldProblems', () => {
  it('shows incomplete fields in copper first, then promotes them to red after save', () => {
    const result = compileTeamValidator(daemonSchema)(document({
      agents: [{ ...document().agents[0], role: '' }],
    }))

    expect(displayFieldProblems(result.fieldProblemsByAgent, new Set(), false).get('researcher')?.role?.weight).toBe('incomplete')
    expect(displayFieldProblems(result.fieldProblemsByAgent, new Set(), true).get('researcher')?.role?.weight).toBe('error')
  })
})
