import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConnectTool } from './ConnectTool'
import { TOOLS_CHANNEL, type CatalogEntry, type ConnectedTool } from '../../lib/tools/client'

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

  it('refuses an address the daemon refuses, in its words', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ error: 'LoomWatch only connects to tools over https://, so nobody on the way can read what an agent sends.' }, 400))))
    render(<ConnectTool catalog={[]} connected={[]} keptIn="keychain" onConnected={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Or paste a tool’s server address'), { target: { value: 'http://mcp.example.com/mcp' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('over https://')
  })
})
