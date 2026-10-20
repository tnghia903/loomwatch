import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { questFor, type Quest } from '../../lib/quests/catalog'
import type { Receipt, ReceiptTokens } from '../../lib/story/receipt'
import { RunReceipt } from './RunReceipt'

afterEach(cleanup)

const receipt = (allowed: boolean): Receipt => ({
  run: 'Run 1',
  outcome: { word: 'Finished', tone: 'ok' },
  endedAt: null,
  asked: 'Find the news',
  took: '1m',
  team: '1 agent',
  ranOn: 'Claude Opus 5.5',
  tokens: null,
  lines: [{ tone: 'bad', text: 'Researcher wasn’t allowed to search the web, and carried on without it', agentId: 'researcher', evidenceId: 'p1', allow: 'web', allowed }],
  checks: [],
})

const tokens: ReceiptTokens = {
  label: 'Tokens', value: '~2.63M', exact: '2,628,961 tokens', cached: '89% cached',
  agents: [{ label: 'Gatherer', value: '~2.25M', exact: '2,245,301 tokens' }, { label: 'Reader', value: '313k', exact: '313,161 tokens' }],
  purposes: [{ label: 'The work', value: '~2.16M', exact: '2,156,068 tokens' }, { label: 'Handovers', value: '219k', exact: '219,035 tokens' }],
  estimate: '~ A turn stopped before it ended, so it counts what was seen until then.',
  cost: '$0.42',
}

describe('RunReceipt', () => {
  // docs/QUESTS.md: on the run that earned it, what the run did and one sentence of why. No lesson.
  it('says what the run earned and, in one sentence, why it works, linking only to where to wear it and the quests', () => {
    const monocle = questFor('monocle') as Quest
    render(<RunReceipt receipt={receipt(false)} onInspectEvidence={vi.fn()} earned={[{ quest: monocle, agentId: 'checker', line: 'Checker sent Writer’s work back once, and the second pass met all 2 items it checks.' }]} />)
    const earned = screen.getByRole('region', { name: 'Earned on this run' })
    expect(earned).toHaveTextContent('New in the wardrobe')
    expect(earned).toHaveTextContent('Button monocle. Checker sent Writer’s work back once')
    expect(earned).toHaveTextContent(monocle.why)
    expect(earned).not.toHaveTextContent('The practice')
    expect(within(earned).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['/agents', '/quests'])
  })

  it('shows no earned block on a run that earned nothing', () => {
    render(<RunReceipt receipt={receipt(false)} onInspectEvidence={vi.fn()} />)
    expect(screen.queryByRole('region', { name: 'Earned on this run' })).toBeNull()
  })

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
  it('reads the run’s tokens as one line, folded, with what it cost, and opens who spent them and on what', () => {
    render(<RunReceipt receipt={{ ...receipt(true), tokens }} onInspectEvidence={vi.fn()} />)
    const line = screen.getByRole('button', { name: '~2.63M · 89% cached' })
    expect(line).toHaveAttribute('aria-expanded', 'false')
    expect(line).toHaveAttribute('title', '2,628,961 tokens')
    expect(screen.getByText('$0.42')).toHaveAttribute('title', 'What this run’s model calls cost: OpenRouter’s charge, your Claude credit at list prices (≈), or your ChatGPT plan')
    expect(screen.queryByRole('group', { name: 'Tokens by agent and by kind of turn' })).toBeNull()

    fireEvent.click(line)
    expect(line).toHaveAttribute('aria-expanded', 'true')
    const breakdown = screen.getByRole('group', { name: 'Tokens by agent and by kind of turn' })
    expect(line).toHaveAttribute('aria-controls', breakdown.id)
    expect([...breakdown.querySelectorAll('dl > div')].map((row) => row.textContent)).toEqual(['Gatherer~2.25M', 'Reader313k', 'The work~2.16M', 'Handovers219k'])
    expect(breakdown.querySelector('dd[title="2,245,301 tokens"]')).toHaveTextContent('~2.25M')
    expect(breakdown).toHaveTextContent('A turn stopped before it ended')

    fireEvent.click(line)
    expect(screen.queryByRole('group', { name: 'Tokens by agent and by kind of turn' })).toBeNull()
  })

  it('prints no Tokens line until the run’s numbers are known', () => {
    render(<RunReceipt receipt={receipt(true)} onInspectEvidence={vi.fn()} />)
    expect(screen.queryByText('Tokens')).toBeNull()
  })

  // How it went moved out of the Details heading: the slip leads with it, stamped in its tone.
  it('stamps how the run ended, dated when the record ends', () => {
    const endedAt = '2026-10-15T05:21:00.000Z'
    render(<RunReceipt receipt={{ ...receipt(true), outcome: { word: 'Failed', tone: 'bad' }, endedAt }} onInspectEvidence={vi.fn()} />)
    // The round stamp is drawn, so it is read by its words: the outcome, then the day.
    const stamp = screen.getByRole('heading', { level: 1, name: /^Failed, / })
    expect(stamp).toHaveClass('receipt-stamp', 'tone-bad')
    expect(stamp.querySelector('time')).toHaveAttribute('dateTime', endedAt)
    expect([...stamp.querySelectorAll('.stamp-word')].map((line) => line.textContent)).toEqual(['FAILED'])
    expect(stamp.querySelector('.stamp-date')).not.toBeNull()
  })

  it('stamps no date when the record has no time, and breaks a long outcome over two lines', () => {
    render(<RunReceipt receipt={{ ...receipt(true), outcome: { word: 'Finished with gaps', tone: 'warn' } }} onInspectEvidence={vi.fn()} />)
    const stamp = screen.getByRole('heading', { level: 1, name: 'Finished with gaps' })
    expect(stamp.querySelector('.stamp-date')).toBeNull()
    expect([...stamp.querySelectorAll('.stamp-word')].map((line) => line.textContent)).toEqual(['FINISHED', 'WITH GAPS'])
  })
})
