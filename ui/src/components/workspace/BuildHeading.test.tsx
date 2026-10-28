import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CheckupFinding } from '../../lib/team-file/checkup'
import { BuildHeading, type HeadingCheckup } from './BuildHeading'

afterEach(cleanup)

const improve: CheckupFinding = {
  id: 'lead-delegation:lead', rule: 'lead-delegation', severity: 'improve', agentId: 'lead', agentIds: ['lead'],
  title: 'Tell Lead when to bring in Writer', why: 'A lead often does the whole job alone.',
  fix: { label: 'Add a hand-off plan', change: { kind: 'append-role', agentId: 'lead', text: 'Hand off.' } },
}
const undone: CheckupFinding = {
  id: 'needs-web:editor', rule: 'needs-web', severity: 'fix', agentId: 'editor', agentIds: ['editor'],
  title: 'Editor can\'t search the web when the team runs on schedule', why: 'A scheduled run declines it.',
  fix: { label: 'Allow web search', change: { kind: 'allow', agentId: 'editor', key: 'web' } },
}

function heading(findings: CheckupFinding[], overrides: Partial<HeadingCheckup> = {}, ready = true) {
  const checkup: HeadingCheckup = { findings, hiddenCount: 0, onRestore: vi.fn(), onOpenAgent: vi.fn(), names: new Map([['lead', 'Lead'], ['editor', 'Editor']]), ...overrides }
  render(<BuildHeading agentCount={2} isValid={ready} checking={false} saveState="saved" onRun={vi.fn()} checkup={checkup} />)
  return checkup
}

describe('BuildHeading checkup', () => {
  it('stays ready, lists what would make the team work better, and opens the agent to fix it', () => {
    const checkup = heading([improve])
    expect(screen.getByRole('heading', { name: 'Your team is ready' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'One way to make it work better' }))
    const list = screen.getByRole('dialog', { name: 'Make this team work better' })
    expect(list).toHaveTextContent('Tell Lead when to bring in Writer')
    // The fix is the agent panel's; the list only takes you there (ADR 0043).
    expect(screen.queryByRole('button', { name: 'Add a hand-off plan' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Not needed' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open Lead' }))
    expect(checkup.onOpenAgent).toHaveBeenCalledWith('lead')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('says "almost ready" when part of the work would go undone, and says why', () => {
    heading([undone, improve])
    expect(screen.getByRole('heading', { name: 'Almost ready' })).toBeInTheDocument()
    expect(screen.getByText(/Editor can't search the web when the team runs on schedule\. A scheduled run declines it\./)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'See all 2' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('waits behind an unfinished team, and brings hidden suggestions back', () => {
    heading([undone], {}, false)
    expect(screen.getByRole('heading', { name: 'Finish setting up' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Fix it/ })).not.toBeInTheDocument()
    cleanup()
    const checkup = heading([improve], { hiddenCount: 2 })
    fireEvent.click(screen.getByRole('button', { name: 'One way to make it work better' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 hidden' }))
    expect(checkup.onRestore).toHaveBeenCalled()
  })

  it('says what a run of this team costs, from its own runs', () => {
    const usage = { runs: 3, perRun: 84_000, agents: [{ id: 'lead', name: 'Lead', perRun: 84_000, share: 1, opening: 29_000 }] }
    const { rerender } = render(<BuildHeading agentCount={1} isValid checking={false} saveState="saved" onRun={vi.fn()} usage={usage} />)
    expect(screen.getByText('About 84k tokens a run')).toHaveAttribute('title', 'Average over the last 3 runs, as the model calls counted it, cached tokens included.')
    rerender(<BuildHeading agentCount={1} isValid checking={false} saveState="saved" onRun={vi.fn()} />)
    expect(screen.queryByText(/tokens a run/)).not.toBeInTheDocument()
  })

  it('puts Apply where the getting-started guide points while Ask’s team is on the canvas', () => {
    render(<BuildHeading agentCount={2} isValid checking={false} saveState="dirty" onRun={vi.fn()} proposal={{ isNew: true, from: 'Ask LoomWatch', lines: [], applying: false, error: null, onApply: vi.fn(), onDiscard: vi.fn() }} />)
    expect(screen.getByRole('heading', { name: 'Check your new team' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveAttribute('data-tour', 'apply-proposal')
    expect(screen.queryByRole('button', { name: /Run team/ })).toBeNull()
  })
})
