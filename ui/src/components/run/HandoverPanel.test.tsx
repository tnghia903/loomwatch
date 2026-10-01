import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ContextPacket } from '../../lib/memory/client'
import { HandoverPanel } from './HandoverPanel'

const packet: ContextPacket = {
  agentId: 'reviewer',
  invocation: 0,
  createdAt: '2026-09-13T14:40:12.000Z',
  text: '## What the team knows\n### House constraints\nbrief/constraints.md\nNever touch main.\n',
  budgetChars: 8000,
  usedChars: 412,
  sections: [
    { kind: 'preamble', label: 'Preamble', rationale: 'Says where the rest of this section came from.', chars: 140 },
    { kind: 'brief', label: 'House constraints', rationale: 'Pinned Brief entry, applies to the whole team.', chars: 272, source: { path: 'brief/constraints.md', sha256: 'c'.repeat(64) } },
    { kind: 'excluded', label: 'Audience and tone', rationale: 'Not included: this entry applies to writer only.', chars: 0, source: { path: 'brief/tone.md', sha256: 'd'.repeat(64) } },
  ],
}

afterEach(cleanup)

describe('HandoverPanel as the packet inspector', () => {
  it('shows each supplied section with the reason it was selected', () => {
    render(<HandoverPanel text="The landscape is crowded." toLabel="Code Reviewer" fromLabel="Researcher" packet={packet} onClose={vi.fn()} />)
    expect(screen.getByText('House constraints')).toBeInTheDocument()
    expect(screen.getByText('Pinned Brief entry, applies to the whole team.')).toBeInTheDocument()
    // The file and its content hash: a packet must be checkable against the bytes it was built
    // from, not just described.
    expect(screen.getByText(/brief\/constraints\.md · cccccccccccc/)).toBeInTheDocument()
  })

  it('shows what was left out and why, because supplied is only honest beside excluded', () => {
    render(<HandoverPanel text="" toLabel="Code Reviewer" fromLabel="Researcher" packet={packet} onClose={vi.fn()} />)
    expect(screen.getByText('Not included: this entry applies to writer only.')).toBeInTheDocument()
    expect(screen.getByText('not included')).toBeInTheDocument()
  })

  it('keeps the "supplied is not followed" caveat', () => {
    render(<HandoverPanel text="handed over" toLabel="Code Reviewer" fromLabel="Researcher" packet={packet} onClose={vi.fn()} />)
    expect(screen.getByText(/Supplied is not followed/)).toBeInTheDocument()
  })

  it('says the entry point had no predecessor rather than showing an empty block', () => {
    render(<HandoverPanel text="" toLabel="Researcher" fromLabel="the preceding stage" packet={null} onClose={vi.fn()} />)
    expect(screen.getByText(/no preceding stage/)).toBeInTheDocument()
    expect(screen.getByText(/this stage is the entry point/)).toBeInTheDocument()
  })

  it('reports a packet read failure instead of implying nothing was supplied', () => {
    render(<HandoverPanel text="handed over" toLabel="Code Reviewer" fromLabel="Researcher" packet={null} packetError="503: archive watching is disabled" onClose={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('archive watching is disabled')
  })

  it('shows nothing about memory for a run that supplied none', () => {
    render(<HandoverPanel text="handed over" toLabel="Code Reviewer" fromLabel="Researcher" packet={null} onClose={vi.fn()} />)
    expect(screen.queryByText('Supplied from memory')).not.toBeInTheDocument()
    expect(screen.getByText('handed over')).toBeInTheDocument()
  })
})
