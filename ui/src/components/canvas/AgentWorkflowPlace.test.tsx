import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentPlace } from '../../lib/team-file/agentPlace'
import { AgentWorkflowPlace } from './AgentWorkflowPlace'

afterEach(cleanup)

const middle: AgentPlace = {
  summary: 'Step 2 of 3 · after RAG researcher and Researcher · hands its work to Writer.',
  final: false,
  canStart: false,
  flow: { step: 2, of: 3, from: [{ id: 'researcher', name: 'RAG researcher', you: false }, { id: 'researcher-2', name: 'Researcher', you: false }], to: [{ id: 'writer', name: 'Writer', you: false }] },
}

describe('AgentWorkflowPlace', () => {
  it('says who hands the agent work, the agent, and who it hands work to, in that order', () => {
    render(<AgentWorkflowPlace agentId="checker" name="Fact checker" place={middle} onFocus={vi.fn()} />)
    const region = screen.getByRole('region', { name: 'In the team' })
    expect(within(region).getByText('Step 2 of 3')).toBeInTheDocument()
    const [from, self, to] = [...region.querySelectorAll('.workflow-thread > li')]
    expect(from).toHaveTextContent(/Takes work from.*RAG researcher.*Researcher/)
    expect(self).toHaveTextContent('Fact checker')
    expect(to).toHaveTextContent(/Hands work to.*Writer/)
    // The sentence the agent is told stays for a screen reader.
    expect(region).toHaveTextContent(middle.summary)
  })

  it('takes you to a neighbour, so a crowded workflow can be walked one card at a time', () => {
    const onFocus = vi.fn()
    render(<AgentWorkflowPlace agentId="checker" name="Fact checker" place={middle} onFocus={onFocus} />)
    fireEvent.click(screen.getByRole('button', { name: 'Writer: show it' }))
    expect(onFocus).toHaveBeenCalledWith('writer')
    fireEvent.click(screen.getByRole('button', { name: 'Researcher: show it' }))
    expect(onFocus).toHaveBeenLastCalledWith('researcher-2')
  })

  it('starts the first step from your request and ends the last at the team’s answer', () => {
    const only: AgentPlace = { summary: 'Step 1 of 1 · receives your request first. Its answer is the team’s output.', final: true, canStart: false, flow: { step: 1, of: 1, from: [], to: [] } }
    render(<AgentWorkflowPlace agentId="researcher" name="RAG researcher" place={only} onFocus={vi.fn()} />)
    expect(screen.getByText('Your request')).toBeInTheDocument()
    expect(screen.getByText('The team’s answer')).toBeInTheDocument()
    // Neither is a card to go to.
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('says the sentence alone for a team without steps, and offers to make the agent start it', () => {
    const helper: AgentPlace = { summary: 'Helps when RAG researcher hands it part of the work.', final: false, canStart: true }
    const onPromoteEntrypoint = vi.fn()
    render(<AgentWorkflowPlace agentId="checker" name="Fact checker" place={helper} onPromoteEntrypoint={onPromoteEntrypoint} />)
    expect(screen.getByText(helper.summary, { selector: 'p' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Make this the starting agent' }))
    expect(onPromoteEntrypoint).toHaveBeenCalled()
  })

  it('shows neighbours without a way there when nothing can take you', () => {
    render(<AgentWorkflowPlace agentId="checker" name="Fact checker" place={middle} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText('Writer')).toBeInTheDocument()
  })
})
