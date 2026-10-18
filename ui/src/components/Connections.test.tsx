import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Connections from './Connections'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const notionTool = { id: 'n1', name: 'Notion', url: 'https://mcp.notion.com/mcp', auth: 'signIn', calls: [{ name: 'notion-search', label: 'Search', description: '', readOnly: true }], checkedAt: null, pending: false, problem: null, tokenHelp: null, notion: true }
const notionEntry = { name: 'Notion', url: 'https://mcp.notion.com/mcp', does: 'Search, read and write pages, and keep your teams’ answers', auth: 'signIn', group: 'work' }
const page = { id: '550e8400-e29b-41d4-a716-446655440000', title: 'Daily News' }

/**
 * The daemon as Connections reaches it: the OpenRouter key, the tools, and the Notion tool's page
 * answers go under. Every request is recorded.
 */
function daemon({ tools = [] as unknown[], destination = null as typeof page | null } = {}) {
  let listed = tools
  let chosen = destination
  const notion = () => (listed.some((tool) => (tool as { notion?: boolean }).notion) ? { connected: true, name: 'Notion', destination: chosen, problem: null } : { connected: false })
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('/api/ai')) return Promise.resolve(response({ openrouter: { connected: true, label: 'sk-or-v1-abc...xyz' } }))
    if (url === '/api/tools' && init?.method === 'POST') return Promise.resolve(response({ tool: { ...notionTool, pending: true }, needs: 'signIn', url: 'https://mcp.notion.com/authorize?client_id=c' }))
    if (url.startsWith('/api/tools/') && init?.method === 'DELETE') { listed = []; return Promise.resolve(response({ removed: true })) }
    if (url.startsWith('/api/tools')) return Promise.resolve(response({ tools: listed, catalog: [notionEntry], keptIn: 'keychain' }))
    if (url === '/api/notion/pages') return Promise.resolve(response({ pages: [page], nextCursor: null }))
    if (url === '/api/notion/destination') { chosen = page; return Promise.resolve(response(notion())) }
    if (url === '/api/notion/connection') return Promise.resolve(response(notion()))
    return Promise.resolve(response({ error: 'Not Found' }, 404))
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('Notion is one of the tools (ADR 0070)', () => {
  it('has no Notion section, sign-in or token of its own', async () => {
    daemon()
    render(<Connections />)
    expect(await screen.findByRole('button', { name: 'Connect a tool' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Notion' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Connect Notion' })).toBeNull()
    expect(screen.queryByLabelText(/integration token/i)).toBeNull()
    expect(screen.getByText(/Notion also lets LoomWatch send your teams’ answers/)).toBeInTheDocument()
  })

  it('chooses the page teams’ answers go under on the Notion tool’s own card', async () => {
    const fetch = daemon({ tools: [notionTool] })
    render(<Connections />)
    const card = (await screen.findByRole('list', { name: 'Connected tools' })).querySelector('li') as HTMLElement
    expect(await within(card).findByText('Choose the page your teams’ answers go under.')).toBeInTheDocument()
    fireEvent.click(within(card).getByRole('button', { name: 'Choose a page' }))
    fireEvent.click(await within(card).findByRole('button', { name: 'Daily News' }))
    expect(await within(card).findByText('Answers go under Daily News now.')).toBeInTheDocument()
    expect(within(card).getByText(/New pages go under/)).toHaveTextContent('New pages go under Daily News.')
    const chose = fetch.mock.calls.find(([url]) => String(url) === '/api/notion/destination')?.[1]
    expect(chose).toMatchObject({ method: 'PUT', body: JSON.stringify({ pageId: page.id }), headers: { 'X-LoomWatch-Request': '1' } })
  })

  it('says what removing Notion stops', async () => {
    daemon({ tools: [notionTool], destination: page })
    render(<Connections />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Notion' }))
    expect(await screen.findByText(/can’t send answers to Notion or read pages for agents/)).toBeInTheDocument()
  })

  describe('sent here from the canvas with ?tool=notion', () => {
    // jsdom's location can't be given a search, so stand in a whole one.
    const real = window.location
    function standIn(search: string) {
      Object.defineProperty(window, 'location', { configurable: true, value: { href: `http://127.0.0.1:3000/connections${search}`, pathname: '/connections', search, hash: '', assign: vi.fn() } })
      return vi.spyOn(window.history, 'replaceState').mockImplementation(() => {})
    }
    afterEach(() => { Object.defineProperty(window, 'location', { configurable: true, value: real }); vi.restoreAllMocks() })

    it('starts signing in to Notion when it isn’t connected', async () => {
      const replace = standIn('?tool=notion')
      const fetch = daemon()
      render(<Connections />)
      const signIn = await screen.findByRole('link', { name: 'Sign in to Notion' })
      expect(signIn).toHaveAttribute('href', 'https://mcp.notion.com/authorize?client_id=c')
      const connect = fetch.mock.calls.find(([url, init]) => String(url) === '/api/tools' && init?.method === 'POST')
      expect(JSON.parse(String(connect?.[1]?.body))).toEqual({ url: 'https://mcp.notion.com/mcp', name: 'Notion' })
      // Said once: a reload doesn't start it again.
      expect(replace).toHaveBeenCalledWith(null, '', '/connections')
    })

    it('opens the page list on the Notion card when it is', async () => {
      standIn('?tool=notion')
      const fetch = daemon({ tools: [notionTool] })
      render(<Connections />)
      expect(await screen.findByRole('button', { name: 'Daily News' })).toBeInTheDocument()
      expect(fetch.mock.calls.some(([url]) => String(url) === '/api/notion/pages')).toBe(true)
      expect(fetch.mock.calls.some(([url, init]) => String(url) === '/api/tools' && init?.method === 'POST')).toBe(false)
    })
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
    expect(list).toHaveTextContent('2 actions · signed in')
    expect(list).toHaveTextContent('List teams · only reads')
    // Only Notion's card says where answers go.
    expect(screen.queryByText('Teams’ answers')).toBeNull()
    expect(screen.getByText(/Agents never get them/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Linear' }))
    expect(await screen.findByText(/Linear is removed/)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Connected tools' })).toBeNull())
    expect(screen.getByRole('button', { name: 'Connect a tool' })).toBeInTheDocument()
  })
})
