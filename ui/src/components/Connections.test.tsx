import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cascaded, heightOf, PHONE, px } from '../test/cascade'
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
function daemon({ tools = [] as unknown[], destination = null as typeof page | null, pages = [page] } = {}) {
  let listed = tools
  let chosen = destination
  const notion = () => (listed.some((tool) => (tool as { notion?: boolean }).notion) ? { connected: true, name: 'Notion', destination: chosen, problem: null } : { connected: false })
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('/api/ai')) return Promise.resolve(response({ openrouter: { connected: true, label: 'sk-or-v1-abc...xyz' } }))
    if (url === '/api/tools' && init?.method === 'POST') return Promise.resolve(response({ tool: { ...notionTool, pending: true }, needs: 'signIn', url: 'https://mcp.notion.com/authorize?client_id=c' }))
    if (url.startsWith('/api/tools/') && init?.method === 'DELETE') { listed = []; return Promise.resolve(response({ removed: true })) }
    if (url.startsWith('/api/tools')) return Promise.resolve(response({ tools: listed, catalog: [notionEntry], keptIn: 'keychain' }))
    if (url === '/api/notion/pages') return Promise.resolve(response({ pages, nextCursor: null }))
    if (url === '/api/notion/destination') { chosen = page; return Promise.resolve(response(notion())) }
    if (url === '/api/notion/connection') return Promise.resolve(response(notion()))
    return Promise.resolve(response({ error: 'Not Found' }, 404))
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

// It goes Home, and says so: "Back to the canvas" named a screen this page isn't reached from.
it('is one of You’s tabs, beside About you and Usage', async () => {
  daemon()
  window.history.replaceState(null, '', '/connections')
  render(<Connections />)
  const you = await screen.findByRole('navigation', { name: 'You' })
  expect(within(you).getByRole('link', { name: 'Connections' })).toHaveAttribute('aria-current', 'page')
  expect(within(you).getByRole('link', { name: 'About you' })).toHaveAttribute('href', '/you')
  expect(screen.queryByRole('link', { name: 'Back to Home' })).toBeNull()
})

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

  it('keeps long words inside the card, and shows a page’s whole title', async () => {
    const long = { id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', title: 'Weekly planning for the capstone team, with every meeting since the start of term, the open questions, and who owns each one before the final review' }
    daemon({ tools: [notionTool], pages: [page, long] })
    render(<Connections />)
    const card = (await screen.findByRole('list', { name: 'Connected tools' })).querySelector('li') as HTMLElement
    fireEvent.click(await within(card).findByRole('button', { name: 'Choose a page' }))
    const title = (await within(card).findByRole('button', { name: long.title })).querySelector('.name') as HTMLElement
    // jsdom lays nothing out, so ask the stylesheets. A grid item, or an item in a flex row, is at
    // least as wide as its widest line unless a rule lets it shrink. One of those between a title
    // and the Tools section lets a long title (even one scrolled out of sight) widen the card past
    // the section's edge.
    const widens: string[] = []
    for (let item: HTMLElement = title; !item.matches('.lw-settings-section'); item = item.parentElement as HTMLElement) {
      const box = item.parentElement as HTMLElement
      const display = cascaded(box, 'display') ?? 'block'
      const flexRow = /flex$/.test(display) && !/^column/.test(cascaded(box, ['flex-direction', 'flex-flow']) ?? 'row')
      const gridGrows = /grid$/.test(display) && !/^minmax\(0,/.test(cascaded(box, 'grid-template-columns') ?? '')
      const shrinks = /^0(px)?$/.test(cascaded(item, 'min-width') ?? '') || (cascaded(item, ['overflow', 'overflow-x']) ?? 'visible') !== 'visible'
      if ((flexRow || gridGrows) && !shrinks) widens.push(`${box.tagName.toLowerCase()}.${box.className} > ${item.tagName.toLowerCase()}`)
    }
    expect(widens).toEqual([])
    expect(cascaded(title, 'white-space')).toBe('normal')
    // With the card held to the section's width, a word with no break in it (an address in a
    // call's description) would run past the card's edge unless it wraps too.
    expect(cascaded(card.querySelector('details ul') as HTMLElement, 'overflow-wrap')).toBe('anywhere')
  })

  it('keeps the page list usable from the keyboard and on a phone', async () => {
    daemon({ tools: [notionTool], pages: [page] })
    render(<Connections />)
    const card = (await screen.findByRole('list', { name: 'Connected tools' })).querySelector('li') as HTMLElement
    fireEvent.click(await within(card).findByRole('button', { name: 'Choose a page' }))
    const row = await within(card).findByRole('button', { name: page.title })
    // The list scrolls, so it cuts off whatever reaches past it, and it has no padding at the
    // sides: the ring a keyboard user follows has to stay inside the row.
    row.setAttribute('data-focus-visible', '')
    const [ring] = (cascaded(row, ['outline', 'outline-width']) ?? '').split(' ')
    expect(px(ring) + px(cascaded(row, 'outline-offset'))).toBeLessThanOrEqual(0)
    expect(heightOf(row, PHONE)).toBeGreaterThanOrEqual(44)
    // A line above and below, so a wrapped title cut off by the scroll reads as more list.
    expect(cascaded(within(card).getByRole('list', { name: 'Notion pages' }), ['border-block', 'border']) ?? 'none').toMatch(/--color-hairline/)
  })

  it('draws no lines around a page list with nothing in it', async () => {
    daemon({ tools: [notionTool], pages: [] })
    render(<Connections />)
    const card = (await screen.findByRole('list', { name: 'Connected tools' })).querySelector('li') as HTMLElement
    fireEvent.click(await within(card).findByRole('button', { name: 'Choose a page' }))
    expect(await within(card).findByText(/No pages found/)).toBeInTheDocument()
    expect(cascaded(within(card).getByRole('list', { name: 'Notion pages' }), ['border-block', 'border'])).toBeNull()
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
