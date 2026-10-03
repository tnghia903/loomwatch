import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentConfig } from '../../lib/team-file/types'
import { AgentPermissions } from './AgentPermissions'

afterEach(cleanup)

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { id: 'researcher', name: 'Researcher', role: 'Research', model: 'm', spawn: { cmd: 'npx', args: ['claude-agent-acp'], env: {}, cwd: '.' }, ...overrides }
}

describe('AgentPermissions', () => {
  it('shows each switch as it is in the team file and says what it means', () => {
    render(<AgentPermissions agent={agent({ allow: { web: true } })} onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Search the web/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /Edit files/ })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: /Run commands/ })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: /Search the web/ })).toHaveTextContent('WebAllowed')
    expect(screen.getByRole('button', { name: /Edit files/ })).toHaveTextContent('Edit filesAsks you')
    // Only a switch that is on adds a line: off is what the tile already says.
    expect(screen.getByText('It can search and read web pages.')).toBeInTheDocument()
    expect(screen.queryByText('It can read, but not change, files.')).not.toBeInTheDocument()
    expect(screen.queryByText(/waits for your answer during a run/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'About Allowed without asking' }))
    expect(screen.getByText(/waits for your answer during a run/)).toBeInTheDocument()
  })

  it('flips one switch at a time, and does nothing when the team is read-only', () => {
    const onChange = vi.fn()
    const { rerender } = render(<AgentPermissions agent={agent({ allow: { web: true } })} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Run commands/ }))
    fireEvent.click(screen.getByRole('button', { name: /Search the web/ }))
    expect(onChange.mock.calls).toEqual([['commands', true], ['web', false]])
    rerender(<AgentPermissions agent={agent()} onChange={onChange} readOnly />)
    expect(screen.getByRole('button', { name: /Edit files/ })).toBeDisabled()
  })

  it('says plainly when the agent’s app never asks, so the switches cannot hold it back', () => {
    render(<AgentPermissions agent={agent({ spawn: { cmd: 'opencode', args: ['acp'], env: {}, cwd: '.' } })} onChange={vi.fn()} />)
    expect(screen.getByText('OpenCode doesn’t ask before it acts, so these switches can’t hold it back.')).toBeInTheDocument()
  })
})
