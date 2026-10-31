import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

import { DEFAULT_MODEL } from '../../lib/ai/modelIds'
import type { TeamDocument } from '../../lib/team-file/types'
import { NewTeamDialog } from './NewTeamDialog'

let fetchMock: ReturnType<typeof vi.fn>

function respond(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** The team file the dialog saved, read back. */
function savedTeam(): { path: string; yaml: string; doc: TeamDocument } {
  const put = fetchMock.mock.calls.find(([url, init]) => url === '/api/team' && init?.method === 'PUT')
  expect(put?.[1]?.headers).toMatchObject({ 'If-None-Match': '*' })
  const body = JSON.parse(String(put?.[1]?.body)) as { path: string; yaml: string }
  return { ...body, doc: parse(body.yaml) as TeamDocument }
}

describe('New team', () => {
  it('creates a ready-to-run team from a template, its agent in My agents, in its project, and goes there', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/team' && init?.method === 'PUT') return respond({ path: 'blog-writer-2.yaml', yaml: '', revision: 'r1' })
      if (url === '/api/jobs') return respond({ folder: '/teams/.jobs', jobs: [], problems: [] })
      const job = /^\/api\/jobs\/([^/]+)$/.exec(url)
      if (job && init?.method === 'PUT') return respond({ ...JSON.parse(String(init.body)) as object, id: job[1], file: `.jobs/${job[1]}.yaml`, version: 1 })
      return respond({ error: 'unexpected' }, 404)
    })
    const created = vi.fn()
    render(<NewTeamDialog existingPaths={['blog-writer.yaml']} project="sutd" onCreated={created} onClose={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: 'Create a team' })
    expect(within(dialog).getByRole('radio', { name: /One assistant/ })).toBeChecked()
    fireEvent.change(within(dialog).getByLabelText('Team name'), { target: { value: 'Blog writer' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create team' }))

    await waitFor(() => expect(created).toHaveBeenCalledWith('blog-writer-2.yaml'))
    const { path, yaml, doc } = savedTeam()
    // The existing file is never overwritten, and the assistant joins My agents on the default model.
    expect(path).toBe('blog-writer-2.yaml')
    const saved = fetchMock.mock.calls.filter(([url, init]) => String(url).startsWith('/api/jobs/') && init?.method === 'PUT')
    expect(saved).toHaveLength(1)
    expect(JSON.parse(String(saved[0][1]?.body))).toMatchObject({ name: 'Assistant', model: DEFAULT_MODEL })
    expect(doc.agents).toEqual([{ id: 'assistant', from: { agent: 'assistant' } }])
    expect(yaml).not.toContain('spawn')
    expect(doc.name).toBe('Blog writer')
    // Same name, own id: the Notebook is filed by id, so sharing one shared the first team's notes.
    expect(doc.id).toBe('blog-writer-2')
    // ADR 0097: a team made in a project's room works in that project.
    expect(doc.project).toBe('sutd')
  })

  // A team always starts with agents: the ones you built, or a template's. There is no empty team.
  it('starts a team with the agents you tick, pointing at them in My agents, and never with none', async () => {
    const reader = { id: 'reader', file: 'reader.yaml', name: 'Reader', instructions: 'Read the sources.', version: 2 }
    const writer = { id: 'writer', file: 'writer.yaml', name: 'Writer', instructions: 'Write the brief.', version: 1 }
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/jobs') return respond({ folder: '/teams/.jobs', jobs: [reader, writer], problems: [] })
      if (url === '/api/team' && init?.method === 'PUT') return respond({ path: 'digest.yaml', yaml: '', revision: 'r1' })
      return respond({ root: '/teams', files: [], teams: [] })
    })
    const created = vi.fn()
    render(<NewTeamDialog existingPaths={[]} onCreated={created} onClose={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: 'Create a team' })
    // The choice is there, disabled, before your agents load: wait for it to be chosen.
    await waitFor(() => expect(within(dialog).getByRole('radio', { name: /My agents/ })).toBeChecked())
    expect(within(dialog).queryByRole('radio', { name: /Empty team/ })).toBeNull()
    fireEvent.change(within(dialog).getByLabelText('Team name'), { target: { value: 'Digest' } })
    // Two agents, none ticked yet: nothing to start with, so nothing is created.
    const create = within(dialog).getByRole('button', { name: 'Create team' })
    expect(create).toBeDisabled()
    expect(within(dialog).getByText('Tick at least one agent.')).toBeInTheDocument()
    const agents = within(dialog).getByRole('group', { name: 'Agents to start with' })
    fireEvent.click(within(agents).getByRole('checkbox', { name: /Writer/ }))
    fireEvent.click(within(agents).getByRole('checkbox', { name: /Reader/ }))
    fireEvent.click(create)

    await waitFor(() => expect(created).toHaveBeenCalledWith('digest.yaml'))
    const { doc } = savedTeam()
    // In the order they are listed in My agents, each the agent itself, not a copy (ADR 0094).
    expect(doc.agents.map((agent) => [agent.id, agent.role, agent.from])).toEqual([
      ['reader', undefined, { agent: 'reader' }],
      ['writer', undefined, { agent: 'writer' }],
    ])
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url).startsWith('/api/jobs/') && init?.method === 'PUT')).toHaveLength(0)
    expect(doc.entrypoint).toBe('reader')
    expect(doc.project).toBeUndefined()
  })

  it('offers a template, and a way to build an agent, to someone who has none', async () => {
    fetchMock.mockImplementation((url: string) => respond(url === '/api/jobs' ? { folder: '/teams/.jobs', jobs: [], problems: [] } : { root: '/teams', files: [], teams: [] }))
    render(<NewTeamDialog existingPaths={[]} onClose={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: 'Create a team' })
    expect(await within(dialog).findByRole('link', { name: /Build your first agent/ })).toHaveAttribute('href', '/agents/new')
    expect(within(dialog).getByRole('radio', { name: /My agents/ })).toBeDisabled()
    expect(within(dialog).getByRole('radio', { name: /One assistant/ })).toBeChecked()
  })
})
