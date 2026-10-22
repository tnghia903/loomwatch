import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunRecord } from '../../lib/runs/client'
import { TeamRail, type TeamRailProps } from './TeamRail'

const FILES: Record<string, string> = {
  'blog.yaml': 'name: Blog post\nagents:\n  - {id: researcher, name: Researcher, from: {agent: researcher, version: 1}}\n  - {id: review, kind: operator, name: You}\n  - {id: writer, name: Writer}\n',
  'trip.yaml': 'name: Trip planner\nagents:\n  - {id: planner, name: Planner}\n',
  'trip-2.yaml': 'name: Trip planner\nagents: []\n',
  'notes.yaml': 'just: words\n',
}

function serve(root: string) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://lw.test')
    if (url.pathname === '/api/teams') {
      return new Response(JSON.stringify({ root, files: Object.keys(FILES), teams: [
        ...Object.keys(FILES).filter((path) => path !== 'notes.yaml').map((path) => ({ path, agentCount: 1 })),
        { path: 'notes.yaml', agentCount: 0, problem: 'not_a_team' },
      ] }), { status: 200 })
    }
    const path = url.searchParams.get('path') ?? ''
    if (url.pathname === '/api/team' && FILES[path]) return new Response(JSON.stringify({ path, revision: 'r1', yaml: FILES[path] }), { status: 200 })
    return new Response('{}', { status: 404 })
  }))
}
beforeEach(() => serve('/Users/ana/LoomWatch/teams'))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** The rail's link to the team in `file`, whatever its place. */
const linkTo = (nav: HTMLElement, file: string) => within(nav).getAllByRole('link').find((link) => new URLSearchParams(link.getAttribute('href')?.split('?')[1]).get('path') === file)!

const run = (teamPath: string, extra: Partial<RunRecord>): RunRecord => ({ runId: teamPath, sessionId: teamPath, teamPath, prompt: '', status: 'succeeded', mode: 'pipeline', entrypoint: 'a', responder: 'a', agentIds: [], createdAt: '2026-10-20T03:00:00Z', startedAt: null, finishedAt: null, error: null, exitCode: null, eventCount: 0, reply: null, ...extra })

function rail(overrides: Partial<TeamRailProps> = {}) {
  const go = vi.fn()
  const onNewTeam = vi.fn()
  render(<TeamRail open={{ path: '/Users/ana/LoomWatch/teams/blog.yaml', name: 'Blog post', agents: [{ id: 'researcher', name: 'Researcher' }, { id: 'writer', name: 'Writer' }, { id: 'editor', name: 'Editor' }] }} runs={[]} savedJobs={[]} view="chat" go={go} onNewTeam={onNewTeam} leave={() => null} {...overrides} />)
  return { go, onNewTeam, nav: screen.getByRole('navigation', { name: 'Your teams' }) }
}

describe('TeamRail', () => {
  it('lists every team by name, marks the open one, and leaves out files that are not teams', async () => {
    const { nav } = rail()
    await within(nav).findByRole('link', { name: 'Blog post' })
    const links = within(nav).getAllByRole('link')
    expect(links.map((link) => link.getAttribute('aria-label'))).toEqual(['Blog post', 'Trip planner', 'Trip planner'])
    // The running app opens a team by its full path; the list names it under the teams folder.
    expect(links[0]).toHaveAttribute('aria-current', 'page')
    expect(links[1]).not.toHaveAttribute('aria-current')
  })

  it('opens another team on the tab you are on', async () => {
    const { go, nav } = rail({ view: 'agents' })
    await within(nav).findByRole('link', { name: 'Blog post' })
    fireEvent.click(linkTo(nav, 'trip.yaml'))
    expect(go).toHaveBeenCalledWith('/?path=trip.yaml&view=agents')
  })

  it('opens on Workflow with no tab in the address, as Home does', async () => {
    const { nav } = rail({ view: 'workflow' })
    await within(nav).findByRole('link', { name: 'Blog post' })
    expect(linkTo(nav, 'trip.yaml')).toHaveAttribute('href', '/?path=trip.yaml')
  })

  // On Windows the open team's path is `C:\…`, and the list names it under the root.
  it('marks the open team when its path is a Windows one', async () => {
    serve('C:\\Users\\ana\\LoomWatch\\teams')
    const { nav } = rail({ open: { path: 'C:\\Users\\ana\\LoomWatch\\teams\\trip.yaml', name: 'Trip planner', agents: [] } })
    await within(nav).findByRole('link', { name: 'Blog post' })
    expect(linkTo(nav, 'trip.yaml')).toHaveAttribute('aria-current', 'page')
    expect(linkTo(nav, 'trip-2.yaml')).not.toHaveAttribute('aria-current')
    expect(within(nav).getAllByRole('link')).toHaveLength(3)
  })

  // The rail stays while teams change beside it (App.tsx). A team is left in place only once it is
  // saved, so the one just left is shown as it was on screen until the folder is read again.
  it('shows the team just left as it was on screen while the folder is read again', async () => {
    const same = { runs: [], savedJobs: [], view: 'chat' as const, go: vi.fn(), onNewTeam: vi.fn(), leave: () => null }
    const blog = { path: '/Users/ana/LoomWatch/teams/blog.yaml', name: 'Blog post', agents: [{ id: 'researcher', name: 'Researcher' }, { id: 'writer', name: 'Writer' }, { id: 'editor', name: 'Editor' }] }
    const view = render(<TeamRail open={blog} {...same} />)
    const nav = screen.getByRole('navigation', { name: 'Your teams' })
    await within(nav).findByRole('link', { name: 'Blog post' })
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    view.rerender(<TeamRail open={{ path: '/Users/ana/LoomWatch/teams/trip.yaml', name: 'Trip planner', agents: [{ id: 'planner', name: 'Planner' }] }} {...same} />)
    expect(linkTo(nav, 'trip.yaml')).toHaveAttribute('aria-current', 'page')
    // Its file as first read had two agents; the team on screen had three.
    expect(linkTo(nav, 'blog.yaml').querySelector('.crew-team')).toHaveClass('n3')
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/teams')
  })

  it('names the open team as it is on screen, before it is saved', async () => {
    const { nav } = rail({ open: { path: 'blog.yaml', name: 'Blog post (draft)', agents: [] } })
    expect(await within(nav).findByRole('link', { name: 'Blog post (draft)' })).toHaveAttribute('aria-current', 'page')
  })

  it('glows what each team is doing, from runs that name it either way', async () => {
    const { nav } = rail({ runs: [
      run('/Users/ana/LoomWatch/teams/trip.yaml', { status: 'running', waitingOn: { node: 'review', name: 'You', kind: 'review_stop', since: '2026-10-20T03:00:00Z', question: 'Go on?', park: 'reloadable', parkNote: '', sendBackAvailable: true } }),
      run('blog.yaml', { status: 'running' }),
    ] })
    expect(await within(nav).findByRole('link', { name: 'Blog post, working' })).toHaveClass('working')
    expect(linkTo(nav, 'trip.yaml')).toHaveAccessibleName('Trip planner, waiting for you')
    expect(linkTo(nav, 'trip-2.yaml')).toHaveAccessibleName('Trip planner')
  })

  it('finds a team by one of its agents, and tells two teams with one name apart by their files', async () => {
    const { nav } = rail()
    await within(nav).findByRole('link', { name: 'Blog post' })
    fireEvent.click(within(nav).getByRole('button', { name: 'Find a team' }))
    const box = screen.getByRole('combobox', { name: 'Find a team' })
    fireEvent.change(box, { target: { value: 'planner' } })
    const found = within(screen.getByRole('listbox', { name: 'Find a team' })).getAllByRole('option')
    expect(found.map((option) => option.textContent).sort()).toEqual(['Trip plannertrip-2.yaml', 'Trip plannertrip.yaml'])
    fireEvent.change(box, { target: { value: 'writer' } })
    expect(within(screen.getByRole('listbox', { name: 'Find a team' })).getAllByRole('option').map((option) => option.textContent)).toEqual(['Blog postResearcher, Writer, Editor'])
  })

  it('starts a new team from the +', async () => {
    const { nav, onNewTeam } = rail()
    fireEvent.click(within(nav).getByRole('button', { name: 'New team' }))
    expect(onNewTeam).toHaveBeenCalledOnce()
  })

  it('draws a team as up to three of its agents', async () => {
    const { nav } = rail()
    const blog = await within(nav).findByRole('link', { name: 'Blog post' })
    expect(blog.querySelector('.crew-team')).toHaveClass('n3')
    expect(linkTo(nav, 'trip-2.yaml').querySelector('.crew-team')).toHaveClass('none')
    expect(linkTo(nav, 'trip.yaml').querySelector('.crew-team')).toHaveClass('n1')
  })
})
