import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CheckupFinding } from '../../lib/team-file/checkup'
import { AgentCheckup } from './AgentCheckup'

afterEach(cleanup)

const web: CheckupFinding = {
  id: 'needs-web:scout', rule: 'needs-web', severity: 'improve', agentId: 'scout', agentIds: ['scout'],
  title: 'Scout must ask you each time it searches the web', why: 'Its instructions need it.',
  fix: { label: 'Allow web search', change: { kind: 'allow', agentId: 'scout', key: 'web' } },
}
const thin: CheckupFinding = {
  id: 'thin-instructions:scout', rule: 'thin-instructions', severity: 'improve', agentId: 'scout', agentIds: ['scout'],
  title: 'Scout’s instructions are very short', why: 'It guesses.', askPrompt: 'Rewrite Scout.',
}

describe('AgentCheckup', () => {
  it('says nothing when there is nothing to improve', () => {
    const { container } = render(<AgentCheckup findings={[]} onFix={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('applies a fix, asks LoomWatch for a rewrite, and hides what is not needed', () => {
    const onFix = vi.fn()
    const onAsk = vi.fn()
    const onDismiss = vi.fn()
    render(<AgentCheckup findings={[web, thin]} onFix={onFix} onAsk={onAsk} onDismiss={onDismiss} />)
    expect(screen.getByText('Make it work better')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Allow web search' }))
    expect(onFix).toHaveBeenCalledWith(web)
    fireEvent.click(screen.getByRole('button', { name: 'Ask LoomWatch to rewrite' }))
    expect(onAsk).toHaveBeenCalledWith('Rewrite Scout.')
    fireEvent.click(screen.getAllByRole('button', { name: 'Not needed' })[1])
    expect(onDismiss).toHaveBeenCalledWith(thin)
  })

  it('says when a suggestion comes from the team’s runs rather than its instructions', () => {
    render(<AgentCheckup findings={[{ ...web, learned: 4 }, thin]} onFix={vi.fn()} />)
    expect(screen.getAllByText(/From the last/)).toHaveLength(1)
    expect(screen.getByText('From the last 4 runs')).toBeInTheDocument()
  })

  it('offers no rewrite when no AI app can answer, and no action on a read-only team', () => {
    const { rerender } = render(<AgentCheckup findings={[thin]} onFix={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Ask LoomWatch to rewrite' })).not.toBeInTheDocument()
    rerender(<AgentCheckup findings={[web, thin]} onFix={vi.fn()} onAsk={vi.fn()} onDismiss={vi.fn()} readOnly />)
    expect(screen.getByText(web.title)).toBeInTheDocument()
    expect(screen.queryByRole('button')).toHaveAccessibleName('About Make it work better')
  })
})
