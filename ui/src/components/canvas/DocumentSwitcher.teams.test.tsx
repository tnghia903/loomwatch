import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { ProjectList } from '../../lib/projects/client'
import type { TeamShape } from '../../lib/projects/studio'
import type { LeaveTeam } from '../../lib/team-file/leaveTeam'
import { DocumentSwitcher, type DocumentSwitcherProps } from './DocumentSwitcher'

const ROOT = '/Users/me/LoomWatch/teams'
const LIST: ProjectList = { projects: [{ id: 'sutd', name: 'SUTD', teams: ['sutd/deck.yaml', 'sutd/notes.yaml'] }], loose: [], missing: [], removed: [] }
const SHAPES: TeamShape[] = [
  { path: 'sutd/deck.yaml', name: 'Slide deck prep', project: 'sutd', schedule: null, seats: [{ kind: 'agent', id: 'maker', name: 'Presentation maker' }] },
  { path: 'sutd/notes.yaml', name: 'Lecture notes', project: 'sutd', schedule: null, seats: [{ kind: 'agent', id: 'taker', name: 'Note taker' }] },
]
vi.mock('../../lib/projects/client', async (importOriginal) => ({ ...(await importOriginal<object>()), useProjects: () => ({ list: LIST, error: null, reload: () => {} }) }))
vi.mock('../../lib/projects/useTeamShapes', () => ({ useTeamShapes: () => ({ root: ROOT, shapes: SHAPES, jobs: [] }) }))
vi.mock('../../lib/team-file/useTeamList', async (importOriginal) => ({ ...(await importOriginal<object>()), useTeamList: () => ({ teams: [], trashed: [], error: null, retry: () => {}, forget: () => {} }) }))

afterEach(() => { cleanup() })

const NOTES = `/?path=${encodeURIComponent('sutd/notes.yaml')}&view=chat`

function renderMenu(leave: Partial<LeaveTeam> = {}, overrides: Partial<DocumentSwitcherProps> = {}) {
  const calls: LeaveTeam = { asks: () => false, go: vi.fn(), saveThenGo: vi.fn(async () => true), dropThenGo: vi.fn(async () => {}), ...leave }
  render(
    <DocumentSwitcher
      path={`${ROOT}/sutd/deck.yaml`} teamName="Slide deck prep" saveState="clean" saveError={null}
      entrypointProblem={null} documentProblems={[]} fieldProblemsByAgent={new Map()} agentNames={new Map()} isValid
      readOnlyReason={null} onSave={vi.fn()} onSaveCopy={vi.fn()} onReload={vi.fn()} onDiscard={vi.fn()}
      onSelectProblem={vi.fn()} problemsOpen={false} onProblemsOpenChange={vi.fn()}
      teams={{ view: 'chat', runs: [], leave: calls }}
      {...overrides}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: /open team menu/ }))
  return calls
}

// The complaint: from a team's chat there was no quick way to another team's chat.
it('opens another team from the team’s name, on the same tab, and closes the menu', () => {
  const leave = renderMenu()
  const menu = screen.getByRole('dialog', { name: 'Team menu' })
  fireEvent.click(within(menu).getByRole('link', { name: /Lecture notes/ }))
  expect(leave.go).toHaveBeenCalledWith(NOTES)
  expect(screen.queryByRole('dialog', { name: 'Team menu' })).not.toBeInTheDocument()
})

it('keeps what is done to the file in the same menu, under the teams', () => {
  renderMenu()
  const menu = screen.getByRole('dialog', { name: 'Team menu' })
  expect(within(menu).getByRole('navigation', { name: 'Teams' })).toBeInTheDocument()
  expect(within(menu).getByRole('button', { name: 'Copy path' })).toBeInTheDocument()
})

// The question an agent's workbench asks when it closes with changes (LeaveConfirm), for this team.
const question = (name: RegExp | string = /Save changes to Slide deck prep\?/) => screen.getByRole('alertdialog', { name })

it('asks about changes not saved before it goes, and goes once they are saved', async () => {
  const leave = renderMenu({ asks: () => true }, { saveState: 'dirty' })
  fireEvent.click(screen.getByRole('link', { name: /Lecture notes/ }))
  expect(leave.go).not.toHaveBeenCalled()
  expect(question()).toHaveTextContent('Save changes to Slide deck prep?')
  expect(within(question()).getByRole('button', { name: 'Save' })).toHaveFocus()
  await act(async () => { fireEvent.click(within(question()).getByRole('button', { name: 'Save' })) })
  expect(leave.saveThenGo).toHaveBeenCalledWith(NOTES)
  expect(screen.queryByRole('dialog', { name: 'Team menu' })).not.toBeInTheDocument()
})

it('says why when keeping the changes failed, and stays', async () => {
  const leave = renderMenu({ asks: () => true, saveThenGo: vi.fn(async () => false) }, { saveState: 'dirty', saveError: 'The disk is full.' })
  fireEvent.click(screen.getByRole('link', { name: /Lecture notes/ }))
  await act(async () => { fireEvent.click(within(question()).getByRole('button', { name: 'Save' })) })
  expect(question('Couldn’t save: The disk is full.')).toBeInTheDocument()
  expect(leave.go).not.toHaveBeenCalled()
})

it('drops the changes and goes on Don’t save, and stays on Cancel', () => {
  const leave = renderMenu({ asks: () => true }, { saveState: 'dirty' })
  fireEvent.click(screen.getByRole('link', { name: /Lecture notes/ }))
  fireEvent.click(within(question()).getByRole('button', { name: 'Cancel' }))
  expect(screen.getByRole('button', { name: 'Copy path' })).toBeInTheDocument()
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  expect(screen.getByRole('dialog', { name: 'Team menu' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('link', { name: /Lecture notes/ }))
  // While it asks, the file's own Discard, which stays on this team, steps aside.
  expect(screen.queryByRole('button', { name: /Discard/ })).not.toBeInTheDocument()
  fireEvent.click(within(question()).getByRole('button', { name: 'Don’t save' }))
  expect(leave.dropThenGo).toHaveBeenCalledWith(NOTES)
  expect(leave.saveThenGo).not.toHaveBeenCalled()
  expect(leave.go).not.toHaveBeenCalled()
})

it('offers no Save that can’t work: with problems to fix, it says so and waits on Cancel', () => {
  const leave = renderMenu({ asks: () => true }, { saveState: 'invalid', isValid: false, documentProblems: [{ message: 'must have a name', yamlPath: ['name'] }] })
  fireEvent.click(screen.getByRole('link', { name: /Lecture notes/ }))
  const ask = question(/Slide deck prep can’t be saved yet\. 1 problem to fix\./)
  expect(within(ask).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  expect(within(ask).getByRole('button', { name: 'Cancel' })).toHaveFocus()
  fireEvent.click(within(ask).getByRole('button', { name: 'Don’t save' }))
  expect(leave.dropThenGo).toHaveBeenCalledWith(NOTES)
})

// The save would always be refused, so the question offers only to read the team again.
it('offers no Save for a team changed outside LoomWatch', () => {
  renderMenu({ asks: () => true }, { saveState: 'conflict' })
  fireEvent.click(screen.getByRole('link', { name: /Lecture notes/ }))
  const ask = question('Slide deck prep was changed outside LoomWatch.')
  expect(within(ask).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  expect(within(ask).getByRole('button', { name: 'Don’t save' })).toBeEnabled()
})

// An agent's workbench open over the team asks its own question first; the move waits for it.
it('lets the page ask first, then goes, or asks about this team in the menu again', () => {
  let carryOn: (() => void) | null = null
  const before = vi.fn((then: () => void) => { carryOn = then })
  let unsaved = false
  const leave: LeaveTeam = { asks: () => unsaved, go: vi.fn(), saveThenGo: vi.fn(async () => true), dropThenGo: vi.fn(async () => {}) }
  render(
    <DocumentSwitcher
      path={`${ROOT}/sutd/deck.yaml`} teamName="Slide deck prep" saveState="clean" saveError={null}
      entrypointProblem={null} documentProblems={[]} fieldProblemsByAgent={new Map()} agentNames={new Map()} isValid
      readOnlyReason={null} onSave={vi.fn()} onSaveCopy={vi.fn()} onReload={vi.fn()} onDiscard={vi.fn()}
      onSelectProblem={vi.fn()} problemsOpen={false} onProblemsOpenChange={vi.fn()}
      teams={{ view: 'chat', runs: [], leave, before }}
    />,
  )
  const pick = () => {
    fireEvent.click(screen.getByRole('button', { name: /open team menu/ }))
    fireEvent.click(screen.getByRole('link', { name: /Lecture notes/ }))
  }
  pick()
  expect(before).toHaveBeenCalledTimes(1)
  expect(leave.go).not.toHaveBeenCalled()
  // Out of the way of the page's question.
  expect(screen.queryByRole('dialog', { name: 'Team menu' })).not.toBeInTheDocument()
  act(() => carryOn?.())
  expect(leave.go).toHaveBeenCalledWith(NOTES)

  unsaved = true
  pick()
  act(() => carryOn?.())
  expect(question()).toBeInTheDocument()
  expect(leave.go).toHaveBeenCalledTimes(1)
})

// On the Team tab the canvas stops a press on itself, so the menu never heard it and stayed open.
it('closes on a press anywhere else, even where the press is stopped', () => {
  renderMenu()
  const canvas = document.createElement('div')
  canvas.addEventListener('pointerdown', (event) => event.stopImmediatePropagation())
  document.body.append(canvas)
  fireEvent.pointerDown(canvas)
  expect(screen.queryByRole('dialog', { name: 'Team menu' })).not.toBeInTheDocument()
  canvas.remove()
})
