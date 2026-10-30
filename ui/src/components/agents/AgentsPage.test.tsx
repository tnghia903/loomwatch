import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { forgetYou } from '../../lib/you/client'
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
