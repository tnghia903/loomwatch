import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

import { forgetYou } from '../../lib/you/client'
import { cascaded, DESKTOP, PHONE } from '../../test/cascade'
import { AgentsPage } from './AgentsPage'

// The builder is its own page of tests; here it only has to say which job it started from.
vi.mock('./AgentBuilder', () => ({ AgentBuilder: ({ startFrom }: { startFrom?: string | null }) => <p>Builder from {startFrom ?? 'nothing'}</p> }))

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/jobs') return new Response(JSON.stringify({ folder: '.jobs', jobs: [], problems: [] }), { status: 200 })
    if (url === '/api/teams') return new Response(JSON.stringify({ root: '/teams', files: [], teams: [] }), { status: 200 })
    return new Response('{}', { status: 404 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); forgetYou() })

const page = () => render(<AgentsPage skills={[]} skillsLoading={false} />)

// The jobs a team's canvas used to hire from are where an agent is built: every new agent starts here.
describe('Building an agent', () => {
  it('starts from a job, on the model its work suits, or blank, and keeps the team it came from', () => {
    window.history.replaceState({}, '', '/agents/new?team=desk%2Fresearch.yaml')
    page()
    expect(screen.getByRole('heading', { name: 'Build an agent' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to the team' })).toHaveAttribute('href', '/?path=desk%2Fresearch.yaml')
    const jobs = screen.getByRole('region', { name: 'Start from a job' })
    // On its job's model from the model table: the strong one, while quality comes first.
    expect(within(jobs).getByRole('button', { name: /^Researcher.*on Claude Opus 5\.5/ })).toBeInTheDocument()
    fireEvent.click(within(jobs).getByRole('button', { name: /^Researcher/ }))
    expect(window.location.pathname + window.location.search).toBe('/agents/new?from=researcher&team=desk%2Fresearch.yaml')
    expect(screen.getByText('Builder from researcher')).toBeInTheDocument()
  })

  it('opens the jobs from New agent on the list, and Blank starts from nothing', () => {
    window.history.replaceState({}, '', '/agents')
    page()
    fireEvent.click(screen.getByRole('button', { name: 'New agent' }))
    fireEvent.click(within(screen.getByRole('region', { name: 'Start from a job' })).getByRole('button', { name: /^Blank/ }))
    expect(window.location.search).toBe('?from=blank')
    expect(screen.getByText('Builder from blank')).toBeInTheDocument()
  })
})

// ADR 0074: every agent here is told what the person told them, and the list says so.
describe('What your agents know about you', () => {
  const answering = (you: unknown) => vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/you') return new Response(JSON.stringify(you), { status: 200 })
    if (url === '/api/jobs') return new Response(JSON.stringify({ folder: '.jobs', jobs: [], problems: [] }), { status: 200 })
    if (url === '/api/teams') return new Response(JSON.stringify({ root: '/teams', files: [], teams: [] }), { status: 200 })
    return new Response('{}', { status: 404 })
  })

  it('says the name they know you by, with the way to change it', async () => {
    vi.stubGlobal('fetch', answering({ name: 'Mai', about: 'Keep it short.', skipped: false }))
    window.history.replaceState({}, '', '/agents')
    page()
    expect(await screen.findByText(/Your agents know you as/)).toHaveTextContent('Your agents know you as Mai. Edit')
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute('href', '/you')
  })

  it('says when they know nothing yet, even after Not now', async () => {
    vi.stubGlobal('fetch', answering({ skipped: true }))
    window.history.replaceState({}, '', '/agents')
    page()
    expect(await screen.findByRole('link', { name: 'Tell them about you' })).toHaveAttribute('href', '/you')
    expect(screen.getByText(/Your agents don’t know you yet/)).toBeInTheDocument()
  })
})

// ADR 0100: each card in My agents has a "…" that removes the agent, off the teams it is in too.
describe('Removing an agent from its card', () => {
  const BLOG = 'schemaVersion: 1\nid: blog\nname: Blog\nentrypoint: writer\nagents:\n  - id: writer\n    name: Writer\n    from: {agent: writer, version: 1}\n    model: fake/offline\n    role: Write.\n  - id: editor\n    from: {agent: editor, version: 1}\n    model: fake/offline\n    role: Edit.\nedges:\n  - {from: writer, to: editor}\n'
  const calls: string[] = []
  let saved = ''
  let team = BLOG
  beforeEach(() => {
    calls.length = 0
    team = BLOG
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method && init.method !== 'GET') calls.push(`${init.method} ${url}`)
      if (url === '/api/jobs') return new Response(JSON.stringify({ folder: '.jobs', jobs: [{ id: 'writer', file: '.jobs/writer.yaml', name: 'Writer', instructions: 'Write.', model: 'fake/offline' }, { id: 'editor', file: '.jobs/editor.yaml', name: 'Editor', instructions: 'Edit.', model: 'fake/offline' }], problems: [] }), { status: 200 })
      if (url === '/api/teams') return new Response(JSON.stringify({ root: '/teams', files: ['blog.yaml'], teams: [{ path: 'blog.yaml', name: 'Blog', agentCount: 2 }] }), { status: 200 })
      if (url.startsWith('/api/team?')) return new Response(JSON.stringify({ path: 'blog.yaml', yaml: team, revision: 'r1' }), { status: 200 })
      if (url === '/api/team' && init?.method === 'PUT') { saved = (JSON.parse(String(init.body)) as { yaml: string }).yaml; return new Response(JSON.stringify({ path: 'blog.yaml', yaml: saved, revision: 'r2' }), { status: 200 }) }
      if (url === '/api/jobs/writer' && init?.method === 'DELETE') return new Response(JSON.stringify({ id: 'writer' }), { status: 200 })
      return new Response('{}', { status: 404 })
    }))
  })

  it('says which teams it comes off, and takes it off them before it goes', async () => {
    window.history.replaceState({}, '', '/agents')
    page()
    const more = await screen.findByRole('button', { name: 'More for Writer' }, { timeout: 3000 })
    // A tile is one button: its "…" sits beside it, never inside it, and pressing it opens no agent.
    expect(more.closest('.agent-card')).toBeNull()
    expect(more.closest('li')?.querySelector('.agent-card')).not.toBeNull()
    fireEvent.click(more)
    expect(window.location.pathname).toBe('/agents')
    fireEvent.click(within(screen.getByRole('menu', { name: 'Writer' })).getByRole('menuitem', { name: 'Remove from My agents…' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove “Writer” from My agents?' })
    // "the team": a team called Blog isn't the person's blog.
    expect(await within(dialog).findByText('It leaves the team Blog too.')).toBeInTheDocument()
    // The one it handed work to starts the team in its place, called by its name in My agents.
    expect(within(dialog).getByText('Blog starts with Editor now.')).toBeInTheDocument()
    // A copy is kept; it doesn't promise the teams can be put back as they were.
    expect(dialog).toHaveTextContent('LoomWatch keeps a copy of it in your teams folder.')
    expect(dialog).not.toHaveTextContent('Nothing is erased')
    expect(calls).toEqual([])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await vi.waitFor(() => expect(calls).toEqual(['PUT /api/team', 'DELETE /api/jobs/writer']))
    expect(saved).not.toContain('id: writer')
    expect(saved).toContain('entrypoint: editor')
  })

  // At phone width the tiles stand two by two: a menu opened on the left one opens from its left edge,
  // so it never runs off the window; on the right one, from its right.
  it('opens a tile’s menu toward the middle of the window at phone width', async () => {
    window.history.replaceState({}, '', '/agents')
    page()
    fireEvent.click(await screen.findByRole('button', { name: 'More for Writer' }, { timeout: 3000 }))
    fireEvent.click(screen.getByRole('button', { name: 'More for Editor' }))
    const [left, right] = screen.getAllByRole('menu')
    expect(left.closest('li')).toBe(screen.getByRole('button', { name: 'More for Writer' }).closest('li'))
    expect(cascaded(left, 'left', PHONE)).toBe('0')
    // Measured from the tile's own left edge: the "…" sits in a strip across the tile's top, which
    // lets every other press through to the tile.
    const strip = left.parentElement as HTMLElement
    expect(strip).toHaveClass('agent-card-menu')
    expect(cascaded(strip, 'left', PHONE)).toBe('6px')
    expect(cascaded(strip, 'pointer-events', PHONE)).toBe('none')
    expect(cascaded(left, 'right', PHONE)).toBe('auto')
    expect(cascaded(right, 'right', PHONE)).toBe('0')
    // A wide window has room on the left: every menu opens from its tile's right.
    expect(cascaded(left, 'right', DESKTOP)).toBe('0')
  })

  it('asks who starts a team it started and handed work to more than one, and starts it with the one picked', async () => {
    team = `${BLOG}  - {from: writer, to: proofer}\n`.replace('agents:\n', 'agents:\n  - id: proofer\n    name: Proofer\n    model: fake/offline\n    role: Proof.\n')
    window.history.replaceState({}, '', '/agents')
    page()
    fireEvent.click(await screen.findByRole('button', { name: 'More for Writer' }, { timeout: 3000 }))
    fireEvent.click(within(screen.getByRole('menu', { name: 'Writer' })).getByRole('menuitem', { name: 'Remove from My agents…' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove “Writer” from My agents?' })
    const who = await within(dialog).findByRole('group', { name: 'Who starts Blog instead?' })
    expect(who).toHaveTextContent('Blog starts with Writer. Who starts it instead?')
    expect(within(dialog).getByRole('button', { name: 'Remove' })).toBeDisabled()
    fireEvent.click(within(who).getByRole('button', { name: 'Proofer' }))
    expect(within(who).getByRole('button', { name: 'Proofer' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await vi.waitFor(() => expect(calls).toEqual(['PUT /api/team', 'DELETE /api/jobs/writer']))
    const after = parse(saved) as { entrypoint: string; edges: { from: string; to: string }[] }
    expect(after.entrypoint).toBe('proofer')
    expect(after.edges.map((edge) => `${edge.from}>${edge.to}`)).toEqual(['proofer>editor'])
  })
})
