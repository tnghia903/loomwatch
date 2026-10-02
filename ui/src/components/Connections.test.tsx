import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Connections from './Connections'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
/** The page also lists the AI apps that can connect (ConnectAiApps); these tests are about Notion, so
    that section is answered on its own and the Notion responses keep their order. */
const routed = (notion: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
  String(input).startsWith('/api/ask/') ? Promise.resolve(response({ url: 'http://127.0.0.1:3000/api/control/mcp', apps: [] })) : notion(input, init))

describe('Notion connections', () => {
  it('clears the submitted secret and shows actionable authentication errors', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ connected: false })).mockResolvedValueOnce(response({ error: 'Notion rejected this token.' }, 401))
    vi.stubGlobal('fetch', routed(fetch))
    render(<Connections />)
    const input = await screen.findByLabelText('Notion integration token')
    fireEvent.change(input, { target: { value: 'test-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect Notion' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Notion rejected this token.')
    expect(input).toHaveValue('')
    expect(fetch.mock.calls[1][1].headers['X-LoomWatch-Request']).toBe('1')
    expect(localStorage.getItem('notion-token')).toBeNull()
  })
  it('searches, selects a destination and disconnects without exposing credentials', async () => {
    const page = { id: '550e8400-e29b-41d4-a716-446655440000', title: 'Daily News' }
    const fetch = vi.fn().mockResolvedValueOnce(response({ connected: true, name: 'My workspace' }))
      .mockResolvedValueOnce(response({ pages: [page], nextCursor: null }))
      .mockResolvedValueOnce(response({ connected: true, name: 'My workspace', destination: page }))
      .mockResolvedValueOnce(response({ connected: false }))
    vi.stubGlobal('fetch', routed(fetch))
    render(<Connections />)
    fireEvent.click(await screen.findByRole('button', { name: 'Search' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Daily News' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Destination saved.')
    expect(fetch.mock.calls[2][1].body).toBe(JSON.stringify({ pageId: page.id }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Disconnect Notion' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Notion' }))
    expect(await screen.findByLabelText('Notion integration token')).toHaveValue('')
    expect(fetch.mock.calls[3][1].method).toBe('DELETE')
  })
})
