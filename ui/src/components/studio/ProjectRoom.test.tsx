import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectRoom } from './ProjectRoom'

let fetchMock: ReturnType<typeof vi.fn>
let assign: ReturnType<typeof vi.fn>

function respond(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

const GATE = 'schemaVersion: 1\nid: gate\nname: Research and design\nproject: sutd\nentrypoint: researcher\nschedule: {cron: "0 17 * * 5"}\nagents:\n  - id: researcher\n    from: {agent: researcher}\nedges: []\n'
const SUTD = {
  id: 'sutd', name: 'SUTD final project', about: 'Colin’s final project: a gate for the library.',
  folders: [{ name: 'SUTD', path: '/Users/colin/SUTD' }], notes: [{ text: 'Colin picked option B.', by: 'Researcher' }], teams: ['sutd/gate.yaml'],
}

let project: typeof SUTD & { mark?: string; putAway?: boolean }

function daemon(url: string, init?: RequestInit) {
  if (url === '/api/projects') return respond({ projects: [project], loose: [], missing: [] })
  if (url === '/api/projects/sutd' && init?.method === 'PUT') {
    const { teams: _teams, ...kept } = project
    project = { ...kept, ...(JSON.parse(String(init.body)) as object), teams: project.teams } as typeof project
    return respond(project)
  }
  if (url === '/api/projects/sutd/notes' && init?.method === 'POST') {
    project = { ...project, notes: [...project.notes, { text: (JSON.parse(String(init.body)) as { text: string }).text, by: undefined as unknown as string }] }
    return respond(project)
  }
  if (url === '/api/jobs') return respond({ folder: '/teams/.jobs', jobs: [{ id: 'researcher', file: '.jobs/researcher.yaml', name: 'Researcher', instructions: 'Research.', version: 1 }], problems: [] })
  if (url.startsWith('/api/team?')) return respond({ path: 'sutd/gate.yaml', yaml: GATE, revision: 'r' })
  if (url === '/api/runs?preview=true') return respond([])
  return respond({ root: '/teams', files: ['sutd/gate.yaml'], teams: [{ path: 'sutd/gate.yaml', name: 'Research and design', agentCount: 1 }], trashed: ['sutd/old.yaml'] })
}

beforeEach(() => {
  project = { ...SUTD }
  assign = vi.fn()
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign, search: '', pathname: '/projects/sutd' } })
  fetchMock = vi.fn(daemon)
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('a project’s room (ADR 0097)', () => {
  it('holds on its wall what every agent here knows, and its teams at their desks', async () => {
    render(<ProjectRoom id="sutd" />)
    expect(await screen.findByRole('heading', { level: 1, name: 'SUTD final project' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'About. Change it' })).toHaveTextContent('Colin’s final project: a gate for the library.')
    expect(screen.getByTitle('/Users/colin/SUTD')).toHaveTextContent('SUTD')
    expect(screen.getByText('Colin picked option B.')).toBeInTheDocument()
    expect(screen.getByText('From Researcher')).toBeInTheDocument()
    // The wall's "?" says what it is, and it stays here.
    fireEvent.click(screen.getByRole('button', { name: 'About What agents here know' }))
    expect(screen.getByRole('note')).toHaveTextContent('Every agent in this project reads these. They stay in this project.')
    const team = await screen.findByRole('link', { name: /Research and design/ })
    expect(team).toHaveAttribute('href', '/?path=sutd%2Fgate.yaml&view=chat')
    expect(team).toHaveTextContent(/On its schedule|Every/)
    expect(await screen.findByRole('group', { name: /Research and design: Researcher/ })).toBeInTheDocument()
  })

  it('changes the About in place, and keeps a note every agent here reads', async () => {
    render(<ProjectRoom id="sutd" />)
    fireEvent.click(await screen.findByRole('button', { name: 'About. Change it' }))
    fireEvent.change(screen.getByRole('textbox', { name: /About/ }), { target: { value: 'The gate, due 12 December.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(project.about).toBe('The gate, due 12 December.'))
    const put = fetchMock.mock.calls.find(([url, init]) => url === '/api/projects/sutd' && init?.method === 'PUT')
    // The whole project, as its file holds it: never the list's own fields.
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      name: 'SUTD final project', about: 'The gate, due 12 December.', folders: SUTD.folders, notes: SUTD.notes,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add a note' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'A note every agent here reads' }), { target: { value: 'Use signed tokens.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    await waitFor(() => expect(screen.getByText('Use signed tokens.')).toBeInTheDocument())
    expect(screen.queryByRole('textbox', { name: 'A note every agent here reads' })).toBeNull()
  })

  it('takes a note off the wall, and puts the project away from its menu', async () => {
    render(<ProjectRoom id="sutd" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Take “Colin picked option B.” off the wall' }))
    await waitFor(() => expect(project.notes).toEqual([]))
    fireEvent.click(screen.getByRole('button', { name: 'Project settings' }))
    fireEvent.click(within(screen.getByRole('menu', { name: 'Project settings' })).getByRole('menuitem', { name: 'Put away' }))
    await waitFor(() => expect(project.putAway).toBe(true))
    expect(await screen.findByText('Put away')).toBeInTheDocument()
  })

  it('opens Add an agent for the agent Home sent here, and a new team never takes a deleted team’s place', async () => {
    window.location.search = '?add=researcher'
    render(<ProjectRoom id="sutd" />)
    const dialog = await screen.findByRole('dialog', { name: 'Add an agent' })
    expect(await within(dialog).findByRole('radio', { name: /Researcher/ })).toBeChecked()
    expect(within(dialog).getByRole('combobox', { name: 'It joins' })).toHaveValue('')
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'It joins' }), { target: { value: 'sutd/gate.yaml' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }))
    expect(assign).toHaveBeenCalledWith('/?path=sutd%2Fgate.yaml&view=agents')
  })

  it('says so when there is no such project', async () => {
    render(<ProjectRoom id="gone" />)
    expect(await screen.findByText(/There is no project “gone”/)).toBeInTheDocument()
  })
})
