import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { ProjectList } from '../../lib/projects/client'
import type { TeamShape } from '../../lib/projects/studio'
import type { RunRecord } from '../../lib/runs/client'
import { TeamSwitch, type TeamSwitchProps } from './TeamSwitch'

const ROOT = '/Users/me/LoomWatch/teams'
const data = vi.hoisted(() => ({ list: null as ProjectList | null, shapes: null as TeamShape[] | null }))
vi.mock('../../lib/projects/client', async (importOriginal) => ({ ...(await importOriginal<object>()), useProjects: () => ({ list: data.list, error: null, reload: () => {} }) }))
vi.mock('../../lib/projects/useTeamShapes', () => ({ useTeamShapes: () => ({ root: ROOT, shapes: data.shapes, jobs: [] }) }))
vi.mock('../../lib/team-file/useTeamList', async (importOriginal) => ({ ...(await importOriginal<object>()), useTeamList: () => ({ teams: [], trashed: [], error: null, retry: () => {}, forget: () => {} }) }))

const team = (path: string, name: string, project: string | null, agents: string[]): TeamShape => ({
  path, name, project, schedule: null, seats: agents.map((agent) => ({ kind: 'agent' as const, id: agent.toLowerCase(), name: agent })),
})

beforeEach(() => {
  data.list = {
    projects: [
      { id: 'home', name: 'Home jobs', teams: ['home/chores.yaml'] },
      { id: 'sutd', name: 'SUTD', teams: ['sutd/deck.yaml', 'sutd/notes.yaml'] },
    ],
    loose: [], missing: [], removed: [],
  }
  data.shapes = [
    team('home/chores.yaml', 'Chores', 'home', ['Planner']),
    team('sutd/deck.yaml', 'Slide deck prep', 'sutd', ['Presentation maker', 'Checker']),
    team('sutd/notes.yaml', 'Lecture notes', 'sutd', ['Note taker']),
  ]
})
afterEach(() => { cleanup() })

function renderSwitch(overrides: Partial<TeamSwitchProps> = {}) {
  const onPick = vi.fn()
  // The running app opens a team by its full path; the projects list it under the teams folder.
  render(<TeamSwitch open={`${ROOT}/sutd/deck.yaml`} view="chat" runs={[]} onPick={onPick} {...overrides} />)
  return onPick
}

it('lists every team by project, the open team’s project first and the open team marked', () => {
  renderSwitch()
  const lists = within(screen.getByRole('navigation', { name: 'Teams' })).getAllByRole('list')
  expect(lists.map((list) => list.getAttribute('aria-label'))).toEqual(['SUTD', 'Home jobs'])
  expect(within(lists[0]).getAllByRole('link').map((link) => link.querySelector('b')?.textContent)).toEqual(['Slide deck prep', 'Lecture notes'])
  expect(within(lists[0]).getByRole('link', { name: /Slide deck prep/ })).toHaveAttribute('aria-current', 'page')
  expect(within(lists[0]).getByRole('link', { name: /Lecture notes/ })).not.toHaveAttribute('aria-current')
})

// From the chat, another team opens on its chat; from the Team tab, on its Team tab.
it('opens another team on the tab on screen', () => {
  const onPick = renderSwitch()
  const notes = screen.getByRole('link', { name: /Lecture notes/ })
  expect(notes).toHaveAttribute('href', `/?path=${encodeURIComponent('sutd/notes.yaml')}&view=chat`)
  fireEvent.click(notes)
  expect(onPick).toHaveBeenCalledWith(`/?path=${encodeURIComponent('sutd/notes.yaml')}&view=chat`)
  cleanup()
  const fromTeam = renderSwitch({ view: 'workflow' })
  fireEvent.click(screen.getByRole('link', { name: /Chores/ }))
  expect(fromTeam).toHaveBeenCalledWith(`/?path=${encodeURIComponent('home/chores.yaml')}`)
})

it('only closes the menu for the team on screen, and leaves a new-tab click to the browser', () => {
  const onPick = renderSwitch()
  fireEvent.click(screen.getByRole('link', { name: /Slide deck prep/ }))
  expect(onPick).toHaveBeenCalledWith(null)
  onPick.mockClear()
  // Read after the menu had its turn, then stopped, since jsdom can't open a tab.
  let leftToBrowser: boolean | null = null
  const browser = (event: MouseEvent) => { leftToBrowser = !event.defaultPrevented; event.preventDefault() }
  document.addEventListener('click', browser)
  fireEvent.click(screen.getByRole('link', { name: /Chores/ }), { metaKey: true })
  document.removeEventListener('click', browser)
  expect(leftToBrowser).toBe(true)
  expect(onPick).not.toHaveBeenCalled()
})

it('lights each team’s figures with what it is doing', () => {
  const waiting = { runId: 'r', teamPath: 'home/chores.yaml', status: 'running', createdAt: '2026-10-31T09:00:00Z', waitingOn: { kind: 'question', node: 'planner', name: 'Planner', since: '2026-10-31T09:00:00Z', question: 'Which day?' } } as unknown as RunRecord
  renderSwitch({ runs: [waiting] })
  const chores = screen.getByRole('link', { name: /Chores/ })
  expect(chores).toHaveTextContent('Planner is waiting for you')
  expect(chores.querySelector('.desk-figure')).toHaveAttribute('data-glow', 'waiting')
})

it('finds a team by its name or an agent’s once there are many, and opens the first with Enter', () => {
  data.list!.projects.push({ id: 'more', name: 'More', teams: ['a', 'b', 'c', 'd'].map((letter) => `more/${letter}.yaml`) })
  data.shapes!.push(...['a', 'b', 'c', 'd'].map((letter) => team(`more/${letter}.yaml`, `Team ${letter.toUpperCase()}`, 'more', [`Agent ${letter}`])))
  const onPick = renderSwitch()
  const find = screen.getByRole('textbox', { name: 'Find a team' })
  expect(find).toHaveFocus()
  fireEvent.change(find, { target: { value: 'note taker' } })
  expect(screen.getAllByRole('link').map((link) => link.querySelector('b')?.textContent)).toEqual(['Lecture notes'])
  fireEvent.keyDown(find, { key: 'Enter' })
  expect(onPick).toHaveBeenCalledWith(`/?path=${encodeURIComponent('sutd/notes.yaml')}&view=chat`)
  fireEvent.change(find, { target: { value: 'zzz' } })
  expect(screen.getByText('No team matches.')).toBeInTheDocument()
})

it('has no find box with a few teams, and nothing to list with only the team on screen', () => {
  renderSwitch()
  expect(screen.queryByRole('textbox', { name: 'Find a team' })).not.toBeInTheDocument()
  cleanup()
  data.list = { projects: [{ id: 'sutd', name: 'SUTD', teams: ['sutd/deck.yaml'] }], loose: [], missing: [], removed: [] }
  renderSwitch()
  expect(screen.queryByRole('navigation', { name: 'Teams' })).not.toBeInTheDocument()
})
