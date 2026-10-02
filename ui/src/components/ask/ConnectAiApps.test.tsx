import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConnectAiApps } from './ConnectAiApps'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const APPS = [
  { id: 'claude', name: 'Claude Code', detected: true, connected: false, connectedAt: null, method: 'command', command: 'claude mcp add --scope user --transport http loomwatch http://127.0.0.1:3000/api/control/mcp --header "Authorization: Bearer lw_••••••••"', canRemove: true, snippetPlace: null },
  { id: 'codex', name: 'Codex', detected: false, connected: false, connectedAt: null, method: 'command', command: 'codex mcp add …', canRemove: true, snippetPlace: null },
  { id: 'opencode', name: 'OpenCode', detected: true, connected: false, connectedAt: null, method: 'snippet', command: null, canRemove: false, snippetPlace: 'the "mcp" section of ~/.config/opencode/opencode.json' },
]

function row(name: string) {
  return screen.getByText(name, { selector: '.t-body-m' }).closest('li') as HTMLElement
}

describe('ConnectAiApps', () => {
  it('connects an installed app with its own command, and cannot connect one that is missing', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/ask/connections') return json(200, { url: 'http://127.0.0.1:3000/api/control/mcp', apps: APPS })
      if (String(input) === '/api/ask/connections/claude' && init?.method === 'POST') return json(200, { ...APPS[0], connected: true, connectedAt: '2026-10-02T09:00:00Z' })
      return json(404, { error: 'unexpected' })
    })
    vi.stubGlobal('fetch', fetch)
    render(<ConnectAiApps />)
    await screen.findByText('Claude Code')
    expect(within(row('Codex')).getByRole('button', { name: 'Connect' })).toBeDisabled()
    expect(within(row('Codex')).getByText('Not installed on this computer')).toBeInTheDocument()
    // What it will run is there to read, with the key hidden.
    expect(within(row('Claude Code')).getByText(/Bearer lw_••••••••/)).toBeInTheDocument()

    fireEvent.click(within(row('Claude Code')).getByRole('button', { name: 'Connect' }))
    expect(await within(row('Claude Code')).findByText('Connected')).toBeInTheDocument()
    expect(within(row('Claude Code')).getByRole('status')).toHaveTextContent('Open Claude Code and ask it to use LoomWatch')
    expect(within(row('Claude Code')).getByRole('button', { name: 'Disconnect' })).toBeEnabled()
  })

  it('gives a snippet app its snippet once, to copy, and says where it goes', async () => {
    const snippet = { loomwatch: { type: 'remote', url: 'http://127.0.0.1:3000/api/control/mcp', headers: { Authorization: 'Bearer lw_real' } } }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/ask/connections'
      ? json(200, { url: 'http://127.0.0.1:3000/api/control/mcp', apps: APPS })
      : json(200, { ...APPS[2], connected: true, snippet })))
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<ConnectAiApps />)
    await screen.findByText('OpenCode', { selector: '.t-body-m' })
    fireEvent.click(within(row('OpenCode')).getByRole('button', { name: 'Get snippet' }))
    expect(await within(row('OpenCode')).findByText(/Paste this into the "mcp" section/)).toBeInTheDocument()
    fireEvent.click(within(row('OpenCode')).getByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(snippet, null, 2))
    expect(await within(row('OpenCode')).findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('says what went wrong when an app refuses the connection', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/ask/connections'
      ? json(200, { url: 'u', apps: APPS })
      : json(502, { error: 'Claude Code didn’t accept the connection: not signed in' })))
    render(<ConnectAiApps />)
    await screen.findByText('Claude Code', { selector: '.t-body-m' })
    fireEvent.click(within(row('Claude Code')).getByRole('button', { name: 'Connect' }))
    expect(await within(row('Claude Code')).findByRole('alert')).toHaveTextContent('not signed in')
    expect(within(row('Claude Code')).getByRole('button', { name: 'Connect' })).toBeEnabled()
  })
})
