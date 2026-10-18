import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { DocumentSwitcher, type DocumentSwitcherProps } from './DocumentSwitcher'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    root: '/teams',
    files: ['trip-planner.yaml', 'trip-planner-2.yaml'],
    teams: [
      { path: 'trip-planner.yaml', name: 'Trip planner', agentCount: 1 },
      { path: 'trip-planner-2.yaml', name: 'Trip planner', agentCount: 1 },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function renderSwitcher(overrides: Partial<DocumentSwitcherProps> = {}) {
  render(
    <DocumentSwitcher
      path="/teams/trip-planner.yaml" teamName="Trip planner" saveState="clean" saveError={null} linesDiffer={0}
      entrypointProblem={null} documentProblems={[]} fieldProblemsByAgent={new Map()} agentNames={new Map()} isValid
      readOnlyReason={null} onSave={vi.fn()} onSaveCopy={vi.fn()} onReload={vi.fn()} onDiscard={vi.fn()}
      onNewTeam={vi.fn()} onSelectProblem={vi.fn()} problemsOpen={false} onProblemsOpenChange={vi.fn()}
      {...overrides}
    />,
  )
}

// There was no way to rename a team short of editing its YAML.
it('renames the open team from the switcher', () => {
  const onRename = vi.fn()
  renderSwitcher({ onRename })
  fireEvent.click(screen.getByRole('button', { name: /open team switcher/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
  const form = screen.getByRole('form', { name: 'Rename team' })
  const field = within(form).getByLabelText('Team name')
  expect(field).toHaveValue('Trip planner')
  fireEvent.change(field, { target: { value: 'Japan trip' } })
  fireEvent.click(within(form).getByRole('button', { name: 'Rename' }))
  expect(onRename).toHaveBeenCalledWith('Japan trip')
  expect(screen.queryByRole('form', { name: 'Rename team' })).not.toBeInTheDocument()
})

it('offers no rename where the team cannot be edited', () => {
  renderSwitcher()
  fireEvent.click(screen.getByRole('button', { name: /open team switcher/ }))
  expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument()
})

it('tells two teams with the same name apart by their files', async () => {
  renderSwitcher()
  fireEvent.click(screen.getByRole('button', { name: /open team switcher/ }))
  const list = screen.getByRole('listbox', { name: 'Your teams' })
  expect(await within(list).findByText('trip-planner-2.yaml')).toBeInTheDocument()
})

// On Windows the open team's path is `C:\Users\…`, and the list names it under the root.
it('marks the open team in the list when its path is a Windows one', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    root: 'C:\\Users\\ana\\LoomWatch\\teams',
    files: ['trip-planner.yaml', 'blog.yaml'],
    teams: [{ path: 'trip-planner.yaml', name: 'Trip planner', agentCount: 1 }, { path: 'blog.yaml', name: 'Blog', agentCount: 1 }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })))
  renderSwitcher({ path: 'C:\\Users\\ana\\LoomWatch\\teams\\trip-planner.yaml' })
  fireEvent.click(screen.getByRole('button', { name: /open team switcher/ }))
  const list = screen.getByRole('listbox', { name: 'Your teams' })
  expect(await within(list).findByRole('option', { name: /Trip planner/ })).toHaveAttribute('aria-selected', 'true')
  expect(within(list).getByRole('option', { name: /Blog/ })).toHaveAttribute('aria-selected', 'false')
})

it('says nothing is left to finish on a valid saved team', () => {
  renderSwitcher()
  expect(screen.queryByText(/to finish/)).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Review' })).not.toBeInTheDocument()
})

// ADR 0043: Reload from disk and Discard both read the file again, so the switcher shows one of
// them: Discard, which asks first, while there are changes; Reload otherwise.
it('offers Discard with unsaved changes and Reload from disk without, never both', () => {
  const onDiscard = vi.fn()
  renderSwitcher({ saveState: 'dirty', onDiscard })
  fireEvent.click(screen.getByRole('button', { name: /open team switcher/ }))
  expect(screen.queryByRole('button', { name: 'Reload from disk' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes?' }))
  expect(onDiscard).toHaveBeenCalledOnce()
  cleanup()

  const onReload = vi.fn()
  renderSwitcher({ saveState: 'clean', onReload })
  fireEvent.click(screen.getByRole('button', { name: /open team switcher/ }))
  expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Reload from disk' }))
  expect(onReload).toHaveBeenCalledOnce()
})
