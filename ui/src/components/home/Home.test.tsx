import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DetectedHarness } from '../../lib/harnesses'
import { Home } from './Home'

const claude: DetectedHarness = { id: 'claude', name: 'Claude', command: 'claude', executablePath: '/bin/claude', acpAvailable: true, spawn: { cmd: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] } }

let assign: ReturnType<typeof vi.fn>
let fetchMock: ReturnType<typeof vi.fn>

function respond(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

beforeEach(() => {
  assign = vi.fn()
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign, search: '', pathname: '/' } })
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function renderHome(harnesses: DetectedHarness[] = [claude], onCreateBlank = vi.fn()) {
  render(<Home harnesses={harnesses} harnessesLoading={false} harnessesError={null} onRetryHarnesses={vi.fn()} onCreateBlank={onCreateBlank} onPalette={vi.fn()} />)
  return { onCreateBlank }
}

describe('Home', () => {
  it('lists teams by name, newest first, and opens one with a single click', async () => {
    fetchMock.mockImplementation(() => respond({
      root: '/teams',
      files: ['old.yaml', 'new.yaml'],
      teams: [
        { path: 'old.yaml', name: 'Old desk', agentCount: 1, modifiedAt: '2026-01-01T00:00:00Z' },
        { path: 'new.yaml', name: 'Research desk', agentCount: 3, modifiedAt: '2026-09-30T00:00:00Z' },
      ],
    }))
    renderHome()
    const cards = await screen.findAllByRole('button', { name: /desk/ })
    expect(cards.map((card) => within(card).getByText(/desk$/).textContent)).toEqual(['Research desk', 'Old desk'])
    expect(cards[0]).toHaveTextContent('3 steps')
    fireEvent.click(cards[0])
    expect(assign).toHaveBeenCalledWith('/?path=new.yaml')
  })

  it('falls back to file names when an older daemon sends no summaries', async () => {
    fetchMock.mockImplementation(() => respond({ root: '/teams', files: ['nested/research-team.yaml'] }))
    renderHome()
    expect(await screen.findByRole('button', { name: /research-team/ })).toBeInTheDocument()
  })

  it('says how to start when there are no teams, and when no AI app is installed', async () => {
    fetchMock.mockImplementation(() => respond({ root: '/teams', files: [], teams: [] }))
    renderHome([])
    expect(await screen.findByText(/No teams yet/)).toBeInTheDocument()
    expect(screen.getByText(/No AI apps found/)).toBeInTheDocument()
  })

  it('creates a ready-to-run team from a template and opens it', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/teams') return respond({ root: '/teams', files: ['blog-writer.yaml'], teams: [{ path: 'blog-writer.yaml', name: 'Blog writer', agentCount: 1 }] })
      if (url === '/api/harnesses/claude/models') return respond({ harnessId: 'claude', models: [{ id: 'default', name: 'Default', thinkingEfforts: [] }], currentModelId: 'sonnet' })
      if (url === '/api/team' && init?.method === 'PUT') return respond({ path: 'blog-writer-2.yaml', yaml: '', revision: 'r1' })
      return respond({ error: 'unexpected' }, 404)
    })
    renderHome()
    await screen.findByRole('button', { name: /Blog writer/ })
    fireEvent.click(screen.getByRole('button', { name: 'New team' }))
    const dialog = screen.getByRole('dialog', { name: 'Create a team' })
    expect(within(dialog).getByRole('radio', { name: /One assistant/ })).toBeChecked()
    fireEvent.change(within(dialog).getByLabelText('Team name'), { target: { value: 'Blog writer' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create team' }))

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/?path=blog-writer-2.yaml'))
    const put = fetchMock.mock.calls.find(([url, init]) => url === '/api/team' && init?.method === 'PUT')
    expect(put?.[1]?.headers).toMatchObject({ 'If-None-Match': '*' })
    const body = JSON.parse(String(put?.[1]?.body)) as { path: string; yaml: string }
    // The existing file is never overwritten, and the agent uses the app's own current model.
    expect(body.path).toBe('blog-writer-2.yaml')
    expect(body.yaml).toContain('model: sonnet')
    expect(body.yaml).toContain('name: Blog writer')
  })

  it('opens an empty team without touching the disk', async () => {
    fetchMock.mockImplementation(() => respond({ root: '/teams', files: [], teams: [] }))
    const { onCreateBlank } = renderHome()
    await screen.findByText(/No teams yet/)
    fireEvent.click(screen.getByRole('button', { name: 'New team' }))
    fireEvent.click(screen.getByRole('radio', { name: /Empty team/ }))
    fireEvent.change(screen.getByLabelText('Team name'), { target: { value: 'Scratch' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }))
    expect(onCreateBlank).toHaveBeenCalledWith('Scratch', 'scratch.yaml')
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
  })
})
