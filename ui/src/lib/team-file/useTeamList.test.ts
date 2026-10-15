import { describe, expect, it } from 'vitest'

import { teamViewFor } from './useTeamList'

describe('where a team picks up', () => {
  it('is its chat once it has one, its agents while it has none, and its workflow in between', () => {
    expect(teamViewFor({ agentCount: 3 }, true)).toBe('chat')
    expect(teamViewFor({ agentCount: 0 }, false)).toBe('agents')
    expect(teamViewFor({ agentCount: 2 }, false)).toBe('workflow')
    // A file that can't be read as a team has nothing to set up on its agents.
    expect(teamViewFor({ agentCount: 0, problem: 'unreadable' }, false)).toBe('workflow')
  })
})
