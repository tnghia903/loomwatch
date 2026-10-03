import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Receipt } from '../../lib/story/receipt'
import { RunReceipt } from './RunReceipt'

afterEach(cleanup)

const receipt = (allowed: boolean): Receipt => ({
  heading: 'Run 1 · Finished',
  asked: 'Find the news',
  took: '1m',
  team: '1 helper',
  ranOn: 'Claude Code',
  lines: [{ tone: 'bad', text: 'Researcher wasn’t allowed to search the web, and carried on without it', agentId: 'researcher', evidenceId: 'p1', allow: 'web', allowed }],
  checks: [],
})

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
})
