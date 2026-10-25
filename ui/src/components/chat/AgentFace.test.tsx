import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { AgentFacts } from '../../lib/chat/faces'
import { AgentCard } from './AgentFace'

afterEach(cleanup)

const facts = (over: Partial<AgentFacts> = {}): AgentFacts => ({
  id: 'writer', name: 'Writer', hue: 2, state: 'idle', stateWords: 'ready', model: 'Claude Opus 5.5',
  role: 'Writes the digest.', step: null, skills: 1, tools: 0, knowledge: 0, ...over,
})

describe('an agent’s card in the team’s chat', () => {
  it('shows the agent’s instructions with their Markdown', async () => {
    const { container } = render(<AgentCard facts={facts({ role: '# Writer\n\nWrite the **digest** from `notes.md`.\n\n- Three bullets' })} />)
    expect(await screen.findByText('digest', { selector: 'strong' })).toBeTruthy()
    expect(screen.getByText('notes.md', { selector: 'code' })).toBeTruthy()
    const role = container.querySelector('.tc-agent-card-role')
    expect(role?.tagName).toBe('DIV')
    expect(role?.querySelector('li')).toHaveTextContent('Three bullets')
    expect(screen.getByText('Click to mention Writer')).toBeTruthy()
  })

  it('leaves the line out for an agent with no instructions', () => {
    const { container } = render(<AgentCard facts={facts({ role: null })} />)
    expect(container.querySelector('.tc-agent-card-role')).toBeNull()
  })
})
