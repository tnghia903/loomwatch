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

// Writer is on its second version; the blog team still has its first.
const writer: SavedJob = { id: 'writer', file: '.jobs/writer.yaml', name: 'Writer', instructions: 'Write a short draft.', model: 'fake/offline', version: 2, savedAt: '2026-10-20T03:00:00Z' }
const BLOG = 'name: Blog\nagents:\n  - {id: writer, name: Writer, role: Write a draft., from: {agent: writer, version: 1}}\n'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/jobs') return new Response(JSON.stringify({ folder: '.jobs', jobs: [writer], problems: [] }), { status: 200 })
    if (url === '/api/jobs/writer' && init?.method === 'PUT') return new Response(JSON.stringify({ ...writer, ...JSON.parse(String(init.body)), version: 3 }), { status: 200 })
    if (url === '/api/jobs/writer/versions') return new Response(JSON.stringify({ versions: [{ version: 2, spec: writer, note: 'Shorter' }, { version: 1, spec: { ...writer, version: 1 } }] }), { status: 200 })
    if (url === '/api/teams') return new Response(JSON.stringify({ root: '/teams', files: ['blog.yaml'], teams: [{ path: 'blog.yaml', name: 'Blog', agentCount: 1 }] }), { status: 200 })
    if (url.startsWith('/api/team?')) return new Response(JSON.stringify({ path: 'blog.yaml', revision: 'r1', yaml: BLOG }), { status: 200 })
    return new Response('{}', { status: 404 })
  }))
  window.history.replaceState({}, '', '/agents/writer')
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); forgetYou() })

// Versions are kept behind the scenes so a team knows when it has an update; nobody reads a number.
describe('An agent’s page without version numbers', () => {
  it('lists no versions and no numbers, and says which teams have an update ready', async () => {
    const { container } = render(<AgentsPage skills={[]} skillsLoading={false} />)
    const usedIn = await screen.findByRole('region', { name: 'Used in' }, { timeout: 5000 })
    expect(await within(usedIn).findByText('Update ready there', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Versions' })).not.toBeInTheDocument()
    expect(screen.getByText(/^Saved /)).toBeInTheDocument()
    expect(screen.getByText(/1 not updated yet/)).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/\bv\d/)
  })

  it('saves a change with plain Save, asks for no note, and says teams update when you choose', async () => {
    const { container } = render(<AgentsPage skills={[]} skillsLoading={false} />)
    fireEvent.change(await screen.findByRole('textbox', { name: /Instructions/ }, { timeout: 5000 }), { target: { value: 'Write a short draft with a title.' } })
    expect(screen.queryByRole('textbox', { name: /What changed/ })).not.toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(await screen.findByText('Saved. Teams that use it get this when you choose Update in them.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/\bv\d/)
  })
})
