import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConnectTool } from './ConnectTool'
import { isToolAddress, TOOLS_CHANNEL, type CatalogEntry, type ConnectedTool } from '../../lib/tools/client'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const tool = (extra: Partial<ConnectedTool> = {}): ConnectedTool => ({
  id: 't1', name: 'Linear', url: 'https://mcp.linear.app/mcp', auth: 'signIn', calls: [{ name: 'create_issue', label: 'Create issue', description: '', readOnly: false }],
  checkedAt: null, pending: false, problem: null, tokenHelp: null, ...extra,
})
const catalog: CatalogEntry[] = [
  { name: 'Linear', url: 'https://mcp.linear.app/mcp', does: 'Find, create and update issues', auth: 'signIn' },
  { name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', does: 'Ask about any public GitHub project', auth: 'none' },
  { name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', does: 'Read code', auth: 'token', tokenHelp: 'https://github.com/settings/personal-access-tokens/new' },
]
/** A list across topics, out of their order, as a daemon might send it. */
const topical: CatalogEntry[] = [
  { name: 'Kiwi.com', url: 'https://mcp.kiwi.com', does: 'Search flights by city and date', auth: 'none', topic: 'travel', example: 'Find the cheapest flight from Hanoi to Tokyo.' },
  { name: 'Todoist', url: 'https://ai.todoist.net/mcp', does: 'Add, find and finish your to-dos', auth: 'signIn', topic: 'tasks' },
  { name: 'Atlassian', url: 'https://mcp.atlassian.com/v1/mcp', does: 'Find and update Jira issues and Confluence pages', auth: 'signIn', topic: 'tasks' },
  { name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', does: 'Read code, issues and pull requests', auth: 'token', topic: 'code', tokenHelp: 'https://github.com/settings/personal-access-tokens/new' },
]
/** The body of the `index`th request. */
const sent = (fetch: ReturnType<typeof vi.fn>, index: number) => {
  const [url, init] = fetch.mock.calls[index] as unknown as [string, RequestInit]
  return { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null, headers: init.headers as Record<string, string> }
}

describe('connecting a tool (ADR 0069)', () => {
  it('connects one that needs no sign-in straight away, and says which are already connected', async () => {
    const deepWiki = tool({ id: 't2', name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', auth: 'none' })
    const fetch = vi.fn(() => Promise.resolve(json({ tool: deepWiki })))
    vi.stubGlobal('fetch', fetch)
    const onConnected = vi.fn()
    render(<ConnectTool catalog={catalog} connected={[tool()]} keptIn="keychain" onConnected={onConnected} />)
    expect(screen.getByRole('button', { name: /Linear/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Linear/ })).toHaveTextContent('Connected')
    fireEvent.click(screen.getByRole('button', { name: /DeepWiki/ }))
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(deepWiki))
    expect(sent(fetch, 0)).toMatchObject({ url: '/api/tools', method: 'POST', body: { url: 'https://mcp.deepwiki.com/mcp', name: 'DeepWiki' } })
    expect(sent(fetch, 0).headers['X-LoomWatch-Request']).toBe('1')
  })

  it('takes a token for a tool that wants one, sends it once, and clears the field', async () => {
    const github = tool({ id: 't3', name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', auth: 'token', pending: true, calls: [], tokenHelp: 'https://github.com/settings/personal-access-tokens/new' })
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ tool: github, needs: 'token' }))
      .mockResolvedValueOnce(json({ error: 'GitHub refused its token. Open Connections and paste a new one.' }, 502))
      .mockResolvedValueOnce(json({ tool: { ...github, pending: false } }))
    vi.stubGlobal('fetch', fetch)
    const onConnected = vi.fn()
    render(<ConnectTool catalog={catalog} connected={[]} keptIn="keychain" onConnected={onConnected} />)
    fireEvent.click(screen.getByRole('button', { name: /^GitHub/ }))
    const field = await screen.findByLabelText('GitHub token')
    expect(screen.getByRole('link', { name: /Make a token on GitHub/ })).toHaveAttribute('href', 'https://github.com/settings/personal-access-tokens/new')
    expect(screen.getByText(/Kept in this Mac’s Keychain/)).toBeInTheDocument()
    fireEvent.change(field, { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('GitHub refused its token.')
    expect(field).toHaveValue('')
    fireEvent.change(field, { target: { value: 'github_pat_123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith({ ...github, pending: false }))
    expect(sent(fetch, 2)).toMatchObject({ url: '/api/tools/t3/token', method: 'POST', body: { token: 'github_pat_123' } })
  })

  it('signs in on the tool’s own site in a new tab and carries on when it says so', async () => {
    const waiting = tool({ pending: true, calls: [] })
    const fetch = vi.fn((_url: string, init?: RequestInit) => Promise.resolve(init?.method === 'POST'
      ? json({ tool: waiting, needs: 'signIn', url: 'https://mcp.linear.app/authorize?state=s1' })
      : json({ tools: [tool()], catalog, keptIn: 'keychain' })))
    vi.stubGlobal('fetch', fetch)
    const onConnected = vi.fn()
    render(<ConnectTool catalog={catalog} connected={[]} keptIn="keychain" onConnected={onConnected} />)
    fireEvent.click(screen.getByRole('button', { name: /Linear/ }))
    const link = await screen.findByRole('link', { name: 'Sign in to Linear' })
    expect(link).toHaveAttribute('href', 'https://mcp.linear.app/authorize?state=s1')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
    fireEvent.click(link)
    expect(screen.getByText(/Finish signing in on Linear’s site/)).toBeInTheDocument()
    // The landing page tells every window how it went.
    const landing = new BroadcastChannel(TOOLS_CHANNEL)
    landing.postMessage({ tool: 't1', outcome: 'connected' })
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(tool()))
    landing.close()
  })

  it('says a declined sign-in in words and lets you try again', async () => {
    const fetch = vi.fn(() => Promise.resolve(json({ tool: tool({ pending: true }), needs: 'signIn', url: 'https://mcp.linear.app/authorize?state=s2' })))
    vi.stubGlobal('fetch', fetch)
    render(<ConnectTool catalog={catalog} connected={[]} keptIn="keychain" onConnected={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Linear/ }))
    fireEvent.click(await screen.findByRole('link', { name: 'Sign in to Linear' }))
    const landing = new BroadcastChannel(TOOLS_CHANNEL)
    landing.postMessage({ tool: 't1', outcome: 'denied' })
    expect(await screen.findByRole('alert')).toHaveTextContent('You didn’t allow LoomWatch, so nothing was connected.')
    expect(screen.getByRole('link', { name: /Open the sign-in again/ })).toBeInTheDocument()
    landing.close()
  })

  it('starts from topics, as the Skills page does, and shows one topic at a time', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no daemon'))))
    render(<ConnectTool catalog={topical} connected={[]} keptIn="keychain" onConnected={vi.fn()} />)
    const topics = screen.getByRole('group', { name: 'Topics' })
    // Only topics the list has, in their order, and every topic shown under its heading at first.
    expect(within(topics).getAllByRole('button').map((chip) => chip.textContent)).toEqual(['All', 'Tasks', 'Travel', 'Apps and code'])
    expect(within(topics).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByRole('heading', { level: 5 }).map((heading) => heading.textContent)).toEqual(['Tasks', 'Travel', 'Apps and code'])
    expect(screen.getByRole('list', { name: 'Travel tools to connect' })).toHaveTextContent('No sign-in needed')
    expect(screen.getByRole('button', { name: /Kiwi\.com/ })).toHaveAttribute('title', 'Try asking: Find the cheapest flight from Hanoi to Tokyo.')

    fireEvent.click(within(topics).getByRole('button', { name: 'Tasks' }))
    expect(within(topics).getByRole('button', { name: 'Tasks' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(topics).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('list', { name: 'Tasks tools to connect' }).querySelectorAll('li')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /Kiwi\.com/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 5 })).not.toBeInTheDocument()

    // The topic shown, picked again, shows them all again.
    fireEvent.click(within(topics).getByRole('button', { name: 'Tasks' }))
    expect(within(topics).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /Kiwi\.com/ })).toBeInTheDocument()
  })

  it('finds a tool by what it does in every topic, and says when none does', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no daemon'))))
    render(<ConnectTool catalog={topical} connected={[]} keptIn="keychain" onConnected={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Travel' }))
    const box = screen.getByRole('searchbox', { name: 'Find a tool or paste its address' })
    fireEvent.change(box, { target: { value: 'jira' } })
    // Words look in every topic, whichever was shown.
    expect(screen.getByRole('list', { name: 'Tools that match jira' })).toHaveTextContent('Atlassian')
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Travel' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument()
    // A topic's name finds its tools too: Kiwi.com never says "travel" itself.
    fireEvent.change(box, { target: { value: 'travel flights' } })
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([expect.stringContaining('Kiwi.com')])
    // Every word must match: Atlassian has issues, but not code.
    fireEvent.change(box, { target: { value: 'code issues' } })
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([expect.stringContaining('GitHub')])
    fireEvent.change(box, { target: { value: 'zoom' } })
    expect(screen.getByRole('status')).toHaveTextContent('No tool here matches “zoom”. Try other words, or pick a topic.')
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.getByText(/Not here\? Find its “MCP server” address/)).toBeInTheDocument()
  })

  it('says a popular service can’t be connected yet, and why, rather than send you to look for its address', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no daemon'))))
    render(<ConnectTool catalog={topical} connected={[]} keptIn="keychain" onConnected={vi.fn()} />)
    const box = screen.getByRole('searchbox', { name: 'Find a tool or paste its address' })
    fireEvent.change(box, { target: { value: 'my Gmail' } })
    expect(screen.getByRole('status')).toHaveTextContent('Gmail can’t be connected yet: Google doesn’t offer it')
    expect(screen.queryByText(/Not here\?/)).not.toBeInTheDocument()
    // The longest name it says wins.
    fireEvent.change(box, { target: { value: 'google calendar' } })
    expect(screen.getByRole('status')).toHaveTextContent('Google Calendar can’t be connected yet')
    fireEvent.change(box, { target: { value: 'Dropbox' } })
    expect(screen.getByRole('status')).toHaveTextContent('Dropbox can’t be connected yet: it lets in only apps it approved by hand.')
    // A name inside another word is not it: an inbox is no Box.
    fireEvent.change(box, { target: { value: 'inbox' } })
    expect(screen.getByRole('status')).toHaveTextContent('No tool here matches “inbox”.')
    expect(screen.getByText(/Not here\? Find its “MCP server” address/)).toBeInTheDocument()
    // Named among other words, it is still said.
    fireEvent.change(box, { target: { value: 'jira slack' } })
    expect(screen.getByRole('status')).toHaveTextContent('Slack can’t be connected yet')
  })

  it('connects any tool by the address pasted in the same box', async () => {
    const custom = tool({ id: 't9', name: 'Example', url: 'https://mcp.example.com/mcp', auth: 'none' })
    const fetch = vi.fn(() => Promise.resolve(json({ tool: custom })))
    vi.stubGlobal('fetch', fetch)
    const onConnected = vi.fn()
    render(<ConnectTool catalog={topical} connected={[]} keptIn="keychain" onConnected={onConnected} />)
    const box = screen.getByRole('searchbox', { name: 'Find a tool or paste its address' })
    fireEvent.change(box, { target: { value: 'https://mcp.example.com/mcp' } })
    // An address is no search: the list and its topics make way for Connect.
    expect(screen.queryByRole('group', { name: 'Topics' })).not.toBeInTheDocument()
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(custom))
    expect(sent(fetch, 0)).toMatchObject({ url: '/api/tools', method: 'POST', body: { url: 'https://mcp.example.com/mcp' } })
    expect(box).toHaveValue('')
  })

  it('refuses an address the daemon refuses, in its words', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ error: 'LoomWatch only connects to tools over https://, so nobody on the way can read what an agent sends.' }, 400))))
    render(<ConnectTool catalog={[]} connected={[]} keptIn="keychain" onConnected={vi.fn()} />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a tool or paste its address' }), { target: { value: 'http://mcp.example.com/mcp' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('over https://')
  })
})

describe('what counts as an address', () => {
  it('takes a web address, or a name with a dot and a path, and leaves words and bare names to find tools', () => {
    expect(isToolAddress('https://mcp.example.com/mcp')).toBe(true)
    expect(isToolAddress('  http://127.0.0.1:8080/mcp ')).toBe(true)
    expect(isToolAddress('mcp.example.com/mcp')).toBe(true)
    expect(isToolAddress('cal.com')).toBe(false)
    expect(isToolAddress('jira issues')).toBe(false)
    expect(isToolAddress('https://mcp.example.com/a b')).toBe(false)
  })
})
