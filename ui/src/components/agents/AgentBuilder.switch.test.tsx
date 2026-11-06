import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SavedJob } from '../../lib/library/jobs'
import { forgetYou } from '../../lib/you/client'
import { AgentsPage } from './AgentsPage'
import { openBenchRows } from '../../test/benchRows'

openBenchRows()

// The bench is drawn with WebGL, which jsdom has none of.
vi.mock('./AgentFigure', () => ({ default: () => null }))

const maya: SavedJob = { id: 'maya', file: '.jobs/maya.yaml', name: 'Maya', instructions: 'Help me with my day.', model: 'fake/offline', savedAt: '2026-10-20T03:00:00Z' }
const writer: SavedJob = { id: 'writer', file: '.jobs/writer.yaml', name: 'Writer', instructions: 'Write a short draft.', model: 'fake/offline' }

let jobs: SavedJob[] = []

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/jobs') return new Response(JSON.stringify({ folder: '.jobs', jobs, problems: [] }), { status: 200 })
    if (url === '/api/pinned-agent') return new Response(JSON.stringify({ agent: null, notchShown: true }), { status: 200 })
    if (url === '/api/teams') return new Response(JSON.stringify({ root: '/teams', files: [], teams: [] }), { status: 200 })
    return new Response('{}', { status: 404 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); forgetYou() })

describe('an agent’s name menu lists My agents only when there is another to go to', () => {
  it('lists them with another one saved, and nothing to go to with this one alone', async () => {
    jobs = [maya, writer]
    window.history.replaceState({}, '', '/agents/maya')
    const { unmount } = render(<AgentsPage skills={[]} skillsLoading={false} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Maya, .*open agent menu$/ }, { timeout: 5000 }))
    const menu = screen.getByRole('dialog', { name: 'Agent menu' })
    expect(await within(menu).findByRole('link', { name: /Writer/ })).toHaveAttribute('href', '/agents/writer')
    unmount()

    jobs = [maya]
    window.history.replaceState({}, '', '/agents/maya')
    render(<AgentsPage skills={[]} skillsLoading={false} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Maya, .*open agent menu$/ }, { timeout: 5000 }))
    const alone = screen.getByRole('dialog', { name: 'Agent menu' })
    expect(within(alone).queryByRole('navigation', { name: 'My agents' })).toBeNull()
    expect(within(alone).getByRole('button', { name: 'Remove from My agents…' })).toBeInTheDocument()
  }, 15_000)

  // One gold fill a screen: on Chat it is Send's, so the name's Save is a gold ring there.
  it('fills Save gold on Build, and rings it on Chat, where Send has the fill', async () => {
    jobs = [maya, writer]
    window.history.replaceState({}, '', '/agents/maya')
    render(<AgentsPage skills={[]} skillsLoading={false} />)
    fireEvent.change(await screen.findByPlaceholderText('Shown under its name', undefined, { timeout: 5000 }), { target: { value: 'Plans my day' } })
    expect(screen.getByRole('button', { name: 'Save' })).toHaveClass('btn-primary')
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Agent view' })).getByRole('button', { name: 'Chat' }))
    const save = await screen.findByRole('button', { name: 'Save' })
    expect(save).toHaveClass('btn-ring')
    expect(save).not.toHaveClass('btn-primary')
  }, 15_000)

  it('gives your first agent, not saved yet, no menu to open: there is nothing in it', async () => {
    jobs = []
    window.history.replaceState({}, '', '/agents/new?from=writer')
    const { container } = render(<AgentsPage skills={[]} skillsLoading={false} />)
    await waitFor(() => expect(container.querySelector('.agent-chip')).not.toBeNull(), { timeout: 5000 })
    expect(screen.queryByRole('button', { name: /open agent menu/ })).toBeNull()
  }, 15_000)
})
