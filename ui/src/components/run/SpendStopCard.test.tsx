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
    // One call can take the run a little over; the card says so instead of hiding it.
    expect(screen.getByText(/Spent \$1\.03 \(the last call took it \$0\.03 over\)\. The agents wait, and nothing more is spent until you answer\./)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add $0.50 and carry on' }))
    await vi.waitFor(() => expect(screen.queryByText('The team used its $1.00 for this run.')).toBeNull())
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/runs/r1/spend')
    expect(JSON.parse(String(init.body))).toEqual({ stopId: 's1', decision: 'add' })
    expect(onRun).toHaveBeenCalledWith({ runId: 'r1' })
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
