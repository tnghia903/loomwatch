import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Receipt, ReceiptTokens } from '../../lib/story/receipt'
import { RunReceipt } from './RunReceipt'

afterEach(cleanup)

const receipt = (allowed: boolean): Receipt => ({
  heading: 'Run 1 · Finished',
  asked: 'Find the news',
  took: '1m',
  team: '1 helper',
  ranOn: 'Claude Code',
  tokens: null,
  lines: [{ tone: 'bad', text: 'Researcher wasn’t allowed to search the web, and carried on without it', agentId: 'researcher', evidenceId: 'p1', allow: 'web', allowed }],
  checks: [],
})

const tokens: ReceiptTokens = {
  label: 'Tokens', value: '~2.63M', exact: '2,628,961 tokens', cached: '89% cached',
  agents: [{ label: 'Gatherer', value: '~2.25M', exact: '2,245,301 tokens' }, { label: 'Reader', value: '313k', exact: '313,161 tokens' }],
  purposes: [{ label: 'The work', value: '~2.16M', exact: '2,156,068 tokens' }, { label: 'Handovers', value: '219k', exact: '219,035 tokens' }],
  estimate: '~ Codex reports only the last model call of each turn, so LoomWatch adds up every call it reported.',
}

describe('RunReceipt', () => {
  // ADR 0037: a refused line offers its switch, and once it is on, says so instead.
  it('offers the switch a refusal names, then says it is allowed from the next run', () => {
    const onAllow = vi.fn()
    const props = { onInspectEvidence: vi.fn(), onAllow }
    const { rerender } = render(<RunReceipt receipt={receipt(false)} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow from now on' }))
    expect(onAllow).toHaveBeenCalledWith('researcher', 'web')
    rerender(<RunReceipt receipt={receipt(true)} {...props} />)
    expect(screen.queryByRole('button', { name: 'Allow from now on' })).toBeNull()
    expect(screen.getByText('Allowed from the next run')).toBeInTheDocument()
  })

  it('offers nothing when the team cannot be changed from here', () => {
    render(<RunReceipt receipt={receipt(false)} onInspectEvidence={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Allow from now on' })).toBeNull()
  })

  // ADR 0043: a line opens its record; a line about a helper alone has no link, because its stage
  // card is just below and selecting it twice over was two controls for one thing.
  it('links a line to its record only, and copies the receipt by that name', () => {
    const onInspectEvidence = vi.fn()
    render(<RunReceipt receipt={{ ...receipt(true), lines: [
      { tone: 'ok', text: 'Researcher finished', agentId: 'researcher' },
      { tone: 'bad', text: 'Researcher wasn’t allowed to search the web', agentId: 'researcher', evidenceId: 'p1' },
    ] }} onInspectEvidence={onInspectEvidence} />)
    expect(screen.queryByRole('button', { name: /Show this helper’s work/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open the record: Researcher wasn’t allowed to search the web' }))
    expect(onInspectEvidence).toHaveBeenCalledWith('p1')
    expect(screen.getByRole('button', { name: 'Copy receipt' })).toBeInTheDocument()
  })

  // Tokens stay one quiet line; who spent them and on what is a click away, never on by default.
  it('reads the run’s tokens as one line, folded, and opens who spent them and on what', () => {
    render(<RunReceipt receipt={{ ...receipt(true), tokens }} onInspectEvidence={vi.fn()} />)
    const line = screen.getByRole('button', { name: '~2.63M · 89% cached' })
    expect(line).toHaveAttribute('aria-expanded', 'false')
    expect(line).toHaveAttribute('title', '2,628,961 tokens')
    expect(screen.queryByRole('group', { name: 'Tokens by agent and by kind of turn' })).toBeNull()

    fireEvent.click(line)
    expect(line).toHaveAttribute('aria-expanded', 'true')
    const breakdown = screen.getByRole('group', { name: 'Tokens by agent and by kind of turn' })
    expect(line).toHaveAttribute('aria-controls', breakdown.id)
    expect([...breakdown.querySelectorAll('dl > div')].map((row) => row.textContent)).toEqual(['Gatherer~2.25M', 'Reader313k', 'The work~2.16M', 'Handovers219k'])
    expect(breakdown.querySelector('dd[title="2,245,301 tokens"]')).toHaveTextContent('~2.25M')
    expect(breakdown).toHaveTextContent('Codex reports only the last model call of each turn')

    fireEvent.click(line)
    expect(screen.queryByRole('group', { name: 'Tokens by agent and by kind of turn' })).toBeNull()
  })

  it('prints no Tokens line until the run’s numbers are known', () => {
    render(<RunReceipt receipt={receipt(true)} onInspectEvidence={vi.fn()} />)
    expect(screen.queryByText('Tokens')).toBeNull()
  })
})
