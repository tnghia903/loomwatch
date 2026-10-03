import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NotionSend, type NotionSendRun } from './NotionSend'
import type { Delivery } from '../../lib/runs/client'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const connected = { connected: true, name: 'Acme', destination: { id: 'p1', title: 'Team answers' } }
const delivery = (status: Delivery['status'], extra: Partial<Delivery> = {}): Delivery => ({
  target: 'notion', status, url: status === 'failed' ? null : 'https://www.notion.so/abc', pageId: null, message: 'Published "x".', deliveredAt: '2026-10-03T08:00:00Z', ...extra,
})
/** Answers the Notion connection and the run endpoints separately, recording every call. */
const daemon = (routes: { connection?: unknown; run?: () => unknown; deliver?: () => unknown }) => {
  const fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('/api/notion/connection')) return Promise.resolve(json(routes.connection ?? connected))
    if (url.endsWith('/deliver')) return Promise.resolve(json(routes.deliver?.() ?? {}))
    return Promise.resolve(json(routes.run?.() ?? {}))
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
const run = (extra: Partial<NotionSendRun> = {}): NotionSendRun => ({ runId: 'r1', status: 'succeeded', delivery: null, deliverTitle: null, ...extra })

describe('the answer’s Notion line (ADR 0038)', () => {
  it('offers Send to Notion for a team that does not send its answers, and shows where it went', async () => {
    const fetch = daemon({ deliver: () => ({ ...run(), delivery: delivery('published') }) })
    render(<NotionSend run={run()} answered />)
    fireEvent.click(await screen.findByRole('button', { name: 'Send to Notion' }))
    expect(await screen.findByText('Sent to Notion.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open page/ })).toHaveAttribute('href', 'https://www.notion.so/abc')
    const call = fetch.mock.calls.find(([url]) => String(url) === '/api/runs/r1/deliver') as unknown as [string, RequestInit]
    expect(call[1].method).toBe('POST')
    expect(call[1].body).toBe('{}')
  })

  it('follows a run that is sending by itself until the daemon records the delivery', async () => {
    let calls = 0
    daemon({ run: () => { calls += 1; return { ...run({ deliverTitle: 'Desk — today' }), delivery: calls > 1 ? delivery('published') : null } } })
    render(<NotionSend run={run({ deliverTitle: 'Desk — today' })} answered />)
    expect(screen.getByText('Sending to Notion…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send to Notion' })).toBeNull()
    expect(await screen.findByText('Sent to Notion.', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  it('says why a delivery failed, and sends the person to Connections when that is the fix', async () => {
    daemon({ connection: { connected: false } })
    render(<NotionSend run={run({ delivery: delivery('failed', { message: 'Notion is not connected. Open Connections and choose a destination page.' }) })} answered />)
    expect(await screen.findByText('Not sent to Notion — Notion isn’t connected yet.')).toBeInTheDocument()
    // Connections opens from the menu, its one way in (ADR 0043): the line says where, not a second link.
    expect(screen.getByText('Connect Notion in Connections, from the menu.')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Connect Notion/ })).toBeNull()
    cleanup()

    daemon({ deliver: () => ({ ...run(), delivery: delivery('skipped', { message: 'A page with this title already exists.' }) }) })
    render(<NotionSend run={run({ delivery: delivery('failed', { message: 'Notion timed out.' }) })} answered />)
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByText(/Already in Notion/)).toBeInTheDocument()
  })

  it('stays out of the way with no answer, and points to Connections before a first send', async () => {
    daemon({})
    const { container } = render(<NotionSend run={run()} answered={false} />)
    expect(container).toBeEmptyDOMElement()
    cleanup()
    daemon({ connection: { connected: true, name: 'Acme', destination: null } })
    render(<NotionSend run={run()} answered />)
    expect(await screen.findByText('To send this answer, connect Notion in Connections, from the menu.')).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
  })
})
