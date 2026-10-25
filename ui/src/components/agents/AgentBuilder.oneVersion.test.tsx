import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SavedJob } from '../../lib/library/jobs'
import { forgetYou } from '../../lib/you/client'
import type { AgentFigureProps } from './AgentFigure'
import { AgentsPage } from './AgentsPage'

// The bench is drawn with WebGL, which jsdom has none of: here it is only its labels.
vi.mock('./AgentFigure', () => ({
  default: ({ labels }: AgentFigureProps) => <div>{labels.map((tag) => <button key={tag.anchor} type="button" aria-label={tag.label}>{tag.text}</button>)}</div>,
}))

// Writer is in the blog team, which points at it (ADR 0094).
const writer: SavedJob = { id: 'writer', file: '.jobs/writer.yaml', name: 'Writer', instructions: 'Write a short draft.', model: 'fake/offline', version: 2, savedAt: '2026-10-20T03:00:00Z' }
const BLOG = 'name: Blog\nagents:\n  - {id: writer, from: {agent: writer}}\n'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/jobs') return new Response(JSON.stringify({ folder: '.jobs', jobs: [writer], problems: [] }), { status: 200 })
    if (url === '/api/jobs/writer' && init?.method === 'PUT') return new Response(JSON.stringify({ ...writer, ...JSON.parse(String(init.body)), version: 3 }), { status: 200 })
    if (url === '/api/teams') return new Response(JSON.stringify({ root: '/teams', files: ['blog.yaml'], teams: [{ path: 'blog.yaml', name: 'Blog', agentCount: 1 }] }), { status: 200 })
    if (url.startsWith('/api/team?')) return new Response(JSON.stringify({ path: 'blog.yaml', revision: 'r1', yaml: BLOG }), { status: 200 })
    return new Response('{}', { status: 404 })
  }))
  window.history.replaceState({}, '', '/agents/writer')
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); forgetYou() })

// ADR 0094: there is one of each agent, the same in every team it's in. Nothing says "update".
describe('An agent’s page, one agent in every team', () => {
  it('names the teams it is in, with nothing to update in them and no numbers', async () => {
    const { container } = render(<AgentsPage skills={[]} skillsLoading={false} />)
    const usedIn = await screen.findByRole('region', { name: 'Used in' }, { timeout: 5000 })
    // The link goes to the team's Agents tab with this agent open.
    expect(await within(usedIn).findByRole('link', { name: /Blog/ }, { timeout: 5000 })).toHaveAttribute('href', '/?path=blog.yaml&view=agents&agent=writer')
    expect(screen.getByText(/^Saved /)).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/update/i)
    expect(container.textContent).not.toMatch(/\bv\d/)
  // Longer than both waits: a missing link fails on the link, not on the test's own time.
  }, 15000)

  it('saves a change with plain Save, asks for no note, and says no more than that it saved', async () => {
    const { container } = render(<AgentsPage skills={[]} skillsLoading={false} />)
    fireEvent.change(await screen.findByRole('textbox', { name: /Instructions/ }, { timeout: 5000 }), { target: { value: 'Write a short draft with a title.' } })
    expect(screen.queryByRole('textbox', { name: /What changed/ })).not.toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(await screen.findByText('Saved.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/update|keeps its copy/i)
  }, 15000)
})
