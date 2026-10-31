import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SpendStopCard } from './SpendStopCard'
import type { SpendStop } from '../../lib/runs/client'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const stop = (extra: Partial<SpendStop> = {}): SpendStop => ({ id: 's1', limitUsd: 1, spentUsd: 1.03, addUsd: 0.5, since: new Date().toISOString(), ...extra })

describe('the spend stop (ADR 0068)', () => {
  it('says the team used its limit, that nothing more is spent, and adds money on your word', async () => {
    const fetch = vi.fn(() => Promise.resolve(json({ runId: 'r1' })))
    vi.stubGlobal('fetch', fetch)
    const onRun = vi.fn()
    render(<SpendStopCard run={{ runId: 'r1', spendStops: [stop()] }} onRun={onRun} />)
    expect(screen.getByText('The team used its $1.00 for this run.')).toBeInTheDocument()
    // A call under way can take the run a little over; the card says so instead of hiding it.
    expect(screen.getByText(/Spent \$1\.03 \(calls already under way took it \$0\.03 over\)\. The agents wait, and nothing more is spent until you answer\./)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add $0.50 and carry on' }))
    await vi.waitFor(() => expect(screen.queryByText('The team used its $1.00 for this run.')).toBeNull())
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/runs/r1/spend')
    expect(JSON.parse(String(init.body))).toEqual({ stopId: 's1', decision: 'add' })
    expect(onRun).toHaveBeenCalledWith({ runId: 'r1' })
  })

  // ADR 0090: a scheduled run's stop has a deadline, and the card says what happens by then.
  it('in a scheduled run, says by when the team finishes or the agent stops by itself', () => {
    const at = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
    render(<SpendStopCard run={{ runId: 'r1', spendStops: [stop({ expiresAt: at })] }} />)
    expect(screen.getByText(/^If nobody answers by .+, the team finishes with what it has\.$/)).toHaveClass('permission-until')
    cleanup()
    render(<SpendStopCard run={{ runId: 'r1', spendStops: [stop({ agent: 'r', name: 'Researcher', limitUsd: 0.3, spentUsd: 0.3, addUsd: 0.15, expiresAt: at })] }} />)
    expect(screen.getByText(/If nobody answers by .+, Researcher stops here\./)).toBeInTheDocument()
    cleanup()
    render(<SpendStopCard run={{ runId: 'r1', spendStops: [stop()] }} />)
    expect(screen.queryByText(/If nobody answers/)).toBeNull()
  })

  it('never blames one call for what parallel work spent past the limit', () => {
    // A lead's two dispatches to the Researcher each cost $0.00316 and crossed a $0.003 guard
    // together: $0.00332 over, more than any one call cost.
    render(<SpendStopCard run={{ runId: 'r1', spendStops: [stop({ agent: 'researcher', name: 'Researcher', limitUsd: 0.003, spentUsd: 0.00632, addUsd: 0.1 })] }} />)
    expect(screen.getByText(/Spent \$0\.00632 \(calls already under way took it \$0\.00332 over\)\. Researcher waits/)).toBeInTheDocument()
    expect(screen.queryByText(/last call/)).toBeNull()
  })

  it('at an agent’s own guard, offers to stop that agent', async () => {
    const fetch = vi.fn(() => Promise.resolve(json({ runId: 'r1' })))
    vi.stubGlobal('fetch', fetch)
    render(<SpendStopCard run={{ runId: 'r1', spendStops: [stop({ agent: 'r', name: 'Researcher', limitUsd: 0.3, spentUsd: 0.3, addUsd: 0.15 })] }} />)
    expect(screen.getByText('Researcher used its $0.30 for this run.')).toBeInTheDocument()
    expect(screen.getByText(/Researcher waits, and nothing more is spent until you answer\./)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Stop Researcher here' }))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ stopId: 's1', decision: 'finish' })
  })

  it('says why an answer did not land, and shows nothing with no stop', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ error: 'That stop is no longer waiting: it was answered, or the run ended.' }, 404))))
    render(<SpendStopCard run={{ runId: 'r1', spendStops: [stop()] }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Finish with what it has' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer waiting')
    // The stop stays until the run's next read says it is gone.
    expect(screen.getByRole('button', { name: 'Finish with what it has' })).toBeEnabled()
    cleanup()
    const { container } = render(<SpendStopCard run={{ runId: 'r1', spendStops: [] }} />)
    expect(container).toBeEmptyDOMElement()
  })
})
