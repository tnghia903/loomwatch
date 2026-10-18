import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Connections from './Connections'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
/** The page also has the OpenRouter key and the AI apps that can connect (ConnectAiApps); these tests
    are about Notion, so those sections are answered on their own and the Notion responses keep their order. */
const routed = (notion: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
  String(input).startsWith('/api/ask/') ? Promise.resolve(response({ url: 'http://127.0.0.1:3000/api/control/mcp', apps: [] }))
    : String(input).startsWith('/api/tools') ? Promise.resolve(response({ tools: [], catalog: [], keptIn: 'keychain' }))
    : String(input).startsWith('/api/ai') ? Promise.resolve(response({ openrouter: { connected: true, label: 'sk-or-v1-abc...xyz' } }))
      : notion(input, init))

describe('Notion connections', () => {
  it('clears the submitted secret and shows actionable authentication errors', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ connected: false })).mockResolvedValueOnce(response({ error: 'Notion rejected this token.' }, 401))
    vi.stubGlobal('fetch', routed(fetch))
    render(<Connections />)
    const input = await screen.findByLabelText('Notion integration token')
    fireEvent.change(input, { target: { value: 'test-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect with token' }))
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

describe('Notion sign-in', () => {
  // jsdom makes location.assign non-configurable, so stand in a whole location.
  const real = window.location
  function standIn(search = '') {
    const assign = vi.fn()
    Object.defineProperty(window, 'location', { configurable: true, value: { href: `http://127.0.0.1:3000/connections${search}`, pathname: '/connections', search, hash: '', assign } })
    return assign
  }
  afterEach(() => { Object.defineProperty(window, 'location', { configurable: true, value: real }) })

  it('connects with the Notion account first and keeps the token way under Advanced', async () => {
    const assign = standIn()
    const fetch = vi.fn().mockResolvedValueOnce(response({ connected: false }))
      .mockResolvedValueOnce(response({ url: 'https://mcp.notion.com/authorize?client_id=c' }))
    vi.stubGlobal('fetch', routed(fetch))
    render(<Connections />)
    const advanced = (await screen.findByText('Advanced: connect with an integration token')).closest('details')
    expect(advanced).not.toHaveAttribute('open')
    expect(advanced).toContainElement(screen.getByLabelText('Notion integration token'))
    fireEvent.click(screen.getByRole('button', { name: 'Connect Notion' }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://mcp.notion.com/authorize?client_id=c'))
    expect(fetch.mock.calls[1][0]).toBe('/api/notion/sign-in')
    expect(fetch.mock.calls[1][1].method).toBe('POST')
    expect(fetch.mock.calls[1][1].headers['X-LoomWatch-Request']).toBe('1')
  })

  it('back from Notion, says so once and lists pages to choose from', async () => {
    standIn('?notion=connected')
    const replace = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {})
    const page = { id: '550e8400-e29b-41d4-a716-446655440000', title: 'Daily News' }
    const fetch = vi.fn().mockResolvedValueOnce(response({ connected: true, name: 'Acme', destination: null, via: 'signIn' }))
      .mockResolvedValueOnce(response({ pages: [page], nextCursor: null }))
    vi.stubGlobal('fetch', routed(fetch))
    render(<Connections />)
    expect(await screen.findByRole('status')).toHaveTextContent('Notion is connected. Choose the page your teams’ answers go under.')
    expect(await screen.findByRole('button', { name: 'Daily News' })).toBeInTheDocument()
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ query: '' })
    expect(screen.getByText(/Connected with your Notion account/)).toBeInTheDocument()
    expect(replace).toHaveBeenCalledWith(null, '', '/connections')
    replace.mockRestore()
  })

  it.each([
    ['denied', 'Notion sign-in was canceled. Nothing changed.'],
    ['expired', 'That sign-in took too long or was already used. Click Connect Notion to try again.'],
    ['failed', 'Notion sign-in didn’t finish. Check your internet connection and try again.'],
  ])('explains a sign-in that ended %s', async (outcome, message) => {
    standIn(`?notion=${outcome}`)
    const replace = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {})
    vi.stubGlobal('fetch', routed(vi.fn().mockResolvedValueOnce(response({ connected: false }))))
    render(<Connections />)
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(await screen.findByRole('button', { name: 'Connect Notion' })).toBeEnabled()
    replace.mockRestore()
  })
})

describe('Connections’ tools (ADR 0069)', () => {
  it('lists each connected tool with what it offers, and removes one', async () => {
    const linear = { id: 't1', name: 'Linear', url: 'https://mcp.linear.app/mcp', auth: 'signIn', calls: [{ name: 'create_issue', label: 'Create issue', description: 'Create a Linear issue.', readOnly: false }, { name: 'list_teams', label: 'List teams', description: '', readOnly: true }], checkedAt: null, pending: false, problem: null, tokenHelp: null }
    let tools = [linear]
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/tools/t1') && init?.method === 'DELETE') { tools = []; return Promise.resolve(response({ removed: true })) }
      if (url.startsWith('/api/tools')) return Promise.resolve(response({ tools, catalog: [], keptIn: 'keychain' }))
      if (url.startsWith('/api/ai')) return Promise.resolve(response({ openrouter: { connected: true, label: 'sk-or-v1-abc...xyz' } }))
      return Promise.resolve(response({ connected: false }))
    })
    vi.stubGlobal('fetch', fetch)
    render(<Connections />)
    const list = await screen.findByRole('list', { name: 'Connected tools' })
    expect(list).toHaveTextContent('Linear')
    expect(list).toHaveTextContent('2 calls · signed in')
    expect(list).toHaveTextContent('List teams · only reads')
    expect(screen.getByText(/Agents never get them/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Linear' }))
    expect(await screen.findByText(/Linear is removed/)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Connected tools' })).toBeNull())
    expect(screen.getByRole('button', { name: 'Connect a tool' })).toBeInTheDocument()
  })
})
