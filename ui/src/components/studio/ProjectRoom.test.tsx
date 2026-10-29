import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  if (url === '/api/team' && init?.method === 'PUT') return respond({ path: 'sutd/gate.yaml', yaml: '', revision: 'r2' })
  if (url === '/api/runs?preview=true') return respond([])
  if (url === '/api/schedules') return respond([])
  if (url === '/api/chat/messages' && init?.method === 'POST') return respond({ route: 'team', message: { id: 'm1' }, run: null })
  return respond({ root: '/teams', files: ['sutd/gate.yaml'], teams: [{ path: 'sutd/gate.yaml', name: 'Research and design', agentCount: 1 }], trashed: ['sutd/old.yaml'] })
}

beforeEach(() => {
  project = { ...SUTD }
  assign = vi.fn()
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign, search: '', pathname: '/projects/sutd' } })
  fetchMock = vi.fn(daemon)
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('a project’s room (ADR 0097)', () => {
  it('holds on its wall what every agent here knows, and its teams at their desks', async () => {
    render(<ProjectRoom id="sutd" />)
    expect(await screen.findByRole('heading', { level: 1, name: 'SUTD final project' })).toBeInTheDocument()
    // The getting-started guide counts a room as Home and points at its New team (lib/tour/steps.ts).
    const newTeam = screen.getByRole('button', { name: 'New team' })
    expect(newTeam).toHaveAttribute('data-tour', 'new-team')
    expect(newTeam.closest('[data-tour="room"]')).toContainElement(screen.getByRole('heading', { level: 1 }))
    expect(screen.getByRole('button', { name: 'About. Change it' })).toHaveTextContent('Colin’s final project: a gate for the library.')
    expect(screen.getByTitle('/Users/colin/SUTD')).toHaveTextContent('SUTD')
    expect(screen.getByText('Colin picked option B.')).toBeInTheDocument()
    expect(screen.getByText('From Researcher')).toBeInTheDocument()
    // The wall's "?" says what it is, and it stays here.
    fireEvent.click(screen.getByRole('button', { name: 'About What agents here know' }))
    expect(screen.getByRole('note')).toHaveTextContent('Every agent in this project reads these. They stay in this project.')
    const team = await screen.findByRole('link', { name: /Research and design/ })
    expect(team).toHaveAttribute('href', '/?path=sutd%2Fgate.yaml&view=chat')
    expect(team).toHaveTextContent(/Every Friday at 5:00/)
    expect(team).not.toHaveTextContent('didn’t finish')
    expect(await screen.findByRole('group', { name: /Research and design: Researcher/ })).toBeInTheDocument()
  })

  it('says beside a team’s name that its last run didn’t finish', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === '/api/runs?preview=true'
      ? respond([{ runId: 'r1', sessionId: 'r1', teamPath: 'sutd/gate.yaml', prompt: 'p', status: 'failed', mode: 'pipeline', entrypoint: 'researcher', responder: 'researcher', agentIds: [], createdAt: '2026-10-28T09:00:00Z', startedAt: '2026-10-28T09:00:00Z', finishedAt: '2026-10-28T09:01:00Z', error: 'Out of credit', exitCode: null, eventCount: null, reply: null }])
      : daemon(url, init))
    render(<ProjectRoom id="sutd" />)
    await waitFor(() => expect(screen.getByRole('link', { name: /Research and design/ })).toHaveTextContent(/^Research and design didn’t finish · Every Friday at 5:00/))
  })

  it('puts the team waiting for you first, and keeps that order while you are here', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    project = { ...SUTD, teams: ['sutd/gate.yaml', 'sutd/blog.yaml'] }
    const BLOG = 'schemaVersion: 1\nid: blog\nname: Blog\nproject: sutd\nentrypoint: writer\nagents:\n  - {id: writer, name: Writer}\nedges: []\n'
    // A review stop with no agent before it: the team waits for you, and no desk shows it.
    let waiting = 'sutd/blog.yaml'
    const waitingRun = () => ({ runId: 'r1', sessionId: 'r1', teamPath: waiting, prompt: 'p', status: 'running', mode: 'pipeline', entrypoint: 'a', responder: 'a', agentIds: [], createdAt: '2026-10-28T09:00:00Z', startedAt: '2026-10-28T09:00:00Z', finishedAt: null, error: null, exitCode: null, eventCount: null, reply: null, waitingOn: { node: 'review', name: 'You', kind: 'review_stop', since: 'x', question: 'Pick', handoverFrom: null, park: 'none', parkNote: '', sendBackAvailable: true } })
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/runs?preview=true') return respond([waitingRun()])
      if (url.startsWith('/api/team?') && url.includes('blog')) return respond({ path: 'sutd/blog.yaml', yaml: BLOG, revision: 'r' })
      if (url === '/api/teams') return respond({ root: '/teams', files: project.teams, teams: [{ path: 'sutd/gate.yaml', name: 'Research and design', agentCount: 1 }, { path: 'sutd/blog.yaml', name: 'Blog', agentCount: 1 }], trashed: [] })
      return daemon(url, init)
    })
    render(<ProjectRoom id="sutd" />)
    const order = () => [...document.querySelectorAll('.room-team-name b')].map((name) => name.textContent)
    const blog = () => screen.getByRole('link', { name: /^Blog/ })
    await waitFor(() => expect(order()).toEqual(['Blog', 'Research and design']))
    expect(blog()).toHaveTextContent(/^Blog waiting for you$/)

    // Now the other team waits: it says so, and stays where it stood.
    waiting = 'sutd/gate.yaml'
    await act(() => vi.advanceTimersByTimeAsync(4100))
    await waitFor(() => expect(screen.getByRole('link', { name: /^Research and design/ })).toHaveTextContent(/^Research and design waiting for you · Every Friday/))
    expect(blog()).toHaveTextContent(/^Blog$/)
    expect(order()).toEqual(['Blog', 'Research and design'])
  })

  // Ruling 1: teams that started as projects of their own can be moved into one project.
  it('moves a team into another of your projects, as the editor saves it', async () => {
    const thesis = { id: 'thesis', name: 'My thesis', teams: [] }
    fetchMock.mockImplementation((url: string, init?: RequestInit) => (url === '/api/projects' ? respond({ projects: [project, thesis], loose: [], missing: [] }) : daemon(url, init)))
    render(<ProjectRoom id="sutd" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Move Research and design to another project' }))
    const menu = screen.getByRole('menu', { name: 'Move Research and design to' })
    // Only the other projects: never the one it is in.
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['My thesis'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'My thesis' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/team' && init?.method === 'PUT')).toBe(true))
    const put = fetchMock.mock.calls.find(([url, init]) => url === '/api/team' && init?.method === 'PUT')
    const body = JSON.parse(String(put?.[1]?.body)) as { path: string; yaml: string }
    // Saved over the file it read, never over a change made since.
    expect(new Headers(put?.[1]?.headers).get('If-Match')).toBe('"r"')
    expect(body.path).toBe('sutd/gate.yaml')
    expect(body.yaml).toContain('project: thesis')
    expect(body.yaml).not.toContain('project: sutd')
    // The rest of the team stays as it was.
    expect(body.yaml).toMatch(/from: \{ ?agent: researcher ?\}/)
    expect(body.yaml).toMatch(/schedule: \{ ?cron: "0 17 \* \* 5" ?\}/)
    expect(await screen.findByRole('status')).toHaveTextContent('Research and design works in My thesis now.')
    expect(within(screen.getByRole('status')).getByRole('link', { name: 'My thesis' })).toHaveAttribute('href', '/projects/thesis')
  })

  it('offers no move when there is no other project', async () => {
    render(<ProjectRoom id="sutd" />)
    expect(await screen.findByRole('link', { name: /Research and design/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /to another project/ })).toBeNull()
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
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByText('Use signed tokens.')).toBeInTheDocument())
    expect(screen.queryByRole('textbox', { name: 'A note every agent here reads' })).toBeNull()
  })

  it('takes a note off the wall, and puts the project away from its menu', async () => {
    render(<ProjectRoom id="sutd" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove “Colin picked option B.”' }))
    await waitFor(() => expect(project.notes).toEqual([]))
    fireEvent.click(screen.getByRole('button', { name: 'Project settings' }))
    fireEvent.click(within(screen.getByRole('menu', { name: 'Project settings' })).getByRole('menuitem', { name: 'Hide from Home' }))
    await waitFor(() => expect(project.putAway).toBe(true))
    expect(await screen.findByText('Hidden from Home')).toBeInTheDocument()
  })

  it('adds the agent Home sent here to one of the project’s teams, and opens its workflow to connect it', async () => {
    window.location.search = '?add=researcher'
    render(<ProjectRoom id="sutd" />)
    const dialog = await screen.findByRole('dialog', { name: 'Add an agent' })
    expect(await within(dialog).findByRole('radio', { name: /Researcher/ })).toBeChecked()
    expect(within(dialog).getByRole('combobox', { name: 'It joins' })).toHaveValue('')
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'It joins' }), { target: { value: 'sutd/gate.yaml' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/?path=sutd%2Fgate.yaml'))
    const put = fetchMock.mock.calls.find(([url, init]) => url === '/api/team' && init?.method === 'PUT')
    const yaml = (JSON.parse(String(put?.[1]?.body)) as { yaml: string }).yaml
    // The team keeps its own Researcher and gains the one added, under an id of its own.
    expect(yaml).toContain('id: researcher\n')
    expect(yaml).toMatch(/- id: researcher-2\n(?:\s+\w+: .*\n)*\s+from:\n\s+agent: researcher\n/)
  })

  describe('at a glance', () => {
    const BLOG = 'schemaVersion: 1\nid: blog\nname: Blog\nproject: sutd\nentrypoint: writer\nagents:\n  - {id: writer, name: Writer}\nedges: []\n'
    const record = (extra: Record<string, unknown>) => ({ runId: 'r', sessionId: 'r', teamPath: 'sutd/gate.yaml', prompt: 'p', status: 'succeeded', mode: 'pipeline', entrypoint: 'researcher', responder: 'researcher', agentIds: [], createdAt: new Date().toISOString(), startedAt: null, finishedAt: new Date().toISOString(), error: null, exitCode: null, eventCount: null, reply: null, ...extra })
    function twoTeams(runs: unknown[], schedules: unknown[] = []) {
      project = { ...SUTD, teams: ['sutd/gate.yaml', 'sutd/blog.yaml'] }
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (url === '/api/runs?preview=true') return respond(runs)
        if (url === '/api/schedules') return respond(schedules)
        if (url.startsWith('/api/team?') && url.includes('blog')) return respond({ path: 'sutd/blog.yaml', yaml: BLOG, revision: 'r' })
        if (url === '/api/teams') return respond({ root: '/teams', files: project.teams, teams: [{ path: 'sutd/gate.yaml', name: 'Research and design', agentCount: 1 }, { path: 'sutd/blog.yaml', name: 'Blog', agentCount: 1 }], trashed: [] })
        return daemon(url, init)
      })
    }
    const posted = () => fetchMock.mock.calls.filter(([url, init]) => url === '/api/chat/messages' && init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)

    it('puts what waits for you first, with Review taking you to it, and a team that stopped with Try again', async () => {
      twoTeams([
        record({ runId: 'w1', teamPath: 'sutd/blog.yaml', status: 'running', finishedAt: null, waitingOn: { node: 'writer', name: 'Writer', kind: 'question', since: '2026-10-28T09:00:00Z', question: 'Which tone?', handoverFrom: null, park: 'none', parkNote: '', sendBackAvailable: false } }),
        record({ runId: 'f1', status: 'failed', prompt: 'Find three sources on gates.' }),
      ])
      render(<ProjectRoom id="sutd" />)
      const tile = await screen.findByRole('region', { name: 'Needs you · 2' })
      fireEvent.click(within(tile).getByRole('button', { name: 'Review: Writer has a question for you' }))
      expect(assign).toHaveBeenCalledWith('/?path=sutd%2Fblog.yaml&run=w1')
      fireEvent.click(within(tile).getByRole('button', { name: 'Try again: Research and design' }))
      // Asked again as it was, in its team's chat, as work.
      await waitFor(() => expect(posted()).toEqual([expect.objectContaining({ teamPath: 'sutd/gate.yaml', text: 'Find three sources on gates.', work: true, to: null })]))
      // What waits for you is the screen's one gold fill; the box's Send is plain meanwhile.
      expect(within(tile).getByRole('button', { name: /^Review/ })).toHaveClass('btn-primary')
      expect(screen.getByRole('button', { name: 'Send' })).not.toHaveClass('btn-primary')
    })

    it('says who is working, what runs next and what this month cost', async () => {
      twoTeams(
        [record({ runId: 'a', teamPath: 'sutd/blog.yaml', status: 'running', finishedAt: null, working: ['writer'], startedAt: new Date().toISOString(), responder: 'writer' }), record({ runId: 'b', spend: { spentUsd: 0.4 } }), record({ runId: 'c', spend: { spentUsd: 0.12 } })],
        [{ teamPath: 'sutd/gate.yaml', teamName: 'Research and design', cron: '0 17 * * 5', timezone: null, describe: '', prompt: '', enabled: true, nextAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), lastRunId: null, lastStatus: null, lastFiredAt: null, lastDelivery: null, deliver: null, problem: null }],
      )
      render(<ProjectRoom id="sutd" />)
      expect(await screen.findByRole('button', { name: /Writer is working/ })).toHaveTextContent('Blog')
      expect(screen.getByRole('region', { name: 'Next' })).toHaveTextContent('Research and design')
      const month = screen.getByRole('region', { name: 'This month' })
      // The run still at work counted nothing yet: what it spends is added as it ends.
      expect(month).toHaveTextContent('at least $0.52')
      expect(month).toHaveTextContent('3 pieces of work')
    })

    it('gives the team you pick work, as its chat would, and only asks which team when there are two', async () => {
      twoTeams([])
      render(<ProjectRoom id="sutd" />)
      const box = await screen.findByRole('form', { name: 'Give work' })
      fireEvent.change(within(box).getByRole('combobox', { name: 'To' }), { target: { value: 'sutd/blog.yaml' } })
      fireEvent.change(within(box).getByRole('textbox'), { target: { value: 'Write the launch post.' } })
      // Nothing waits for you, so Send is the one gold fill.
      expect(within(box).getByRole('button', { name: 'Send' })).toHaveClass('btn-primary')
      fireEvent.click(within(box).getByRole('button', { name: 'Send' }))
      await waitFor(() => expect(posted()).toEqual([expect.objectContaining({ teamPath: 'sutd/blog.yaml', text: 'Write the launch post.', work: true })]))
      expect(await within(box).findByRole('status')).toHaveTextContent('Blog has it.')
      expect(posted()[0].startKey).toEqual(expect.any(String))
      cleanup()
      project = { ...SUTD }
      fetchMock.mockImplementation(daemon)
      render(<ProjectRoom id="sutd" />)
      expect(await screen.findByRole('textbox', { name: 'What should Research and design do next?' })).toBeInTheDocument()
      expect(screen.queryByRole('combobox', { name: 'To' })).toBeNull()
    })

    it('lists what each team made, newest first, narrowed to one team, and each team’s newest on its card', async () => {
      twoTeams([
        record({ runId: 'old', finishedAt: '2026-10-27T09:00:00Z', made: ['/teams/sources.csv', '/teams/build.py'] }),
        record({ runId: 'new', teamPath: 'sutd/blog.yaml', responder: 'writer', finishedAt: '2026-10-28T09:00:00Z', made: ['/teams/launch post.md'] }),
      ])
      render(<ProjectRoom id="sutd" />)
      const made = await screen.findByRole('region', { name: 'Made here' })
      const names = () => [...made.querySelectorAll('.file-card-name')].map((name) => name.textContent)
      // Code isn't something made to read: it stays in the chat.
      expect(names()).toEqual(['launch post.md', 'sources.csv'])
      fireEvent.click(within(made).getByRole('button', { name: 'Research and design' }))
      expect(names()).toEqual(['sources.csv'])
      expect(within(made).getByRole('button', { name: 'Research and design' })).toHaveAttribute('aria-pressed', 'true')
      expect(within(screen.getByRole('article', { name: 'Blog' })).getByRole('button', { name: /launch post\.md/ })).toBeInTheDocument()
    })
  })

  it('says so when there is no such project', async () => {
    render(<ProjectRoom id="gone" />)
    expect(await screen.findByText(/There is no project “gone”/)).toBeInTheDocument()
  })
})
