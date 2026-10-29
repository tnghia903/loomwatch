import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { DocumentSwitcher, type DocumentSwitcherProps } from './DocumentSwitcher'

afterEach(() => { cleanup() })

function renderSwitcher(overrides: Partial<DocumentSwitcherProps> = {}) {
  render(
    <DocumentSwitcher
      path="/teams/trip-planner.yaml" teamName="Trip planner" saveState="clean" saveError={null}
      entrypointProblem={null} documentProblems={[]} fieldProblemsByAgent={new Map()} agentNames={new Map()} isValid
      readOnlyReason={null} onSave={vi.fn()} onSaveCopy={vi.fn()} onReload={vi.fn()} onDiscard={vi.fn()}
      onSelectProblem={vi.fn()} problemsOpen={false} onProblemsOpenChange={vi.fn()}
      {...overrides}
    />,
  )
}

// There was no way to rename a team short of editing its YAML.
it('renames the open team from its menu', async () => {
  const onRename = vi.fn(async () => null)
  renderSwitcher({ onRename })
  fireEvent.click(screen.getByRole('button', { name: /open team menu/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
  const form = screen.getByRole('form', { name: 'Rename team' })
  const field = within(form).getByLabelText('Team name')
  expect(field).toHaveValue('Trip planner')
  fireEvent.change(field, { target: { value: 'Japan trip' } })
  fireEvent.click(within(form).getByRole('button', { name: 'Rename' }))
  expect(onRename).toHaveBeenCalledWith('Japan trip')
  await waitFor(() => expect(screen.queryByRole('form', { name: 'Rename team' })).not.toBeInTheDocument())
})

// ADR 0099: the file moves with the name, so a refusal (the team is working, say) is said where
// the name was typed, and the name stays there to try again.
it('says why a rename was refused and keeps the new name to try again', async () => {
  const onRename = vi.fn(async () => 'This team is working right now. Stop the work or wait for it to finish, then rename the team.')
  renderSwitcher({ onRename })
  fireEvent.click(screen.getByRole('button', { name: /open team menu/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
  const form = screen.getByRole('form', { name: 'Rename team' })
  fireEvent.change(within(form).getByLabelText('Team name'), { target: { value: 'Japan trip' } })
  fireEvent.click(within(form).getByRole('button', { name: 'Rename' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('This team is working right now.')
  const field = within(screen.getByRole('form', { name: 'Rename team' })).getByLabelText('Team name')
  expect(field).toHaveValue('Japan trip')
  expect(field).toHaveAccessibleDescription(/This team is working right now\./)
  expect(field).toBeInvalid()
})

// The file moves while the button waits, so a second press can't start a second move.
it('keeps Rename pressed until the file has moved', async () => {
  let moved: (refused: string | null) => void = () => {}
  const onRename = vi.fn(() => new Promise<string | null>((resolve) => { moved = resolve }))
  renderSwitcher({ onRename })
  fireEvent.click(screen.getByRole('button', { name: /open team menu/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
  const form = screen.getByRole('form', { name: 'Rename team' })
  fireEvent.change(within(form).getByLabelText('Team name'), { target: { value: 'Japan trip' } })
  fireEvent.click(within(form).getByRole('button', { name: 'Rename' }))
  expect(within(form).getByRole('button', { name: 'Rename' })).toBeDisabled()
  moved(null)
  await waitFor(() => expect(screen.queryByRole('form', { name: 'Rename team' })).not.toBeInTheDocument())
})

// A saved team's file moves at once, so changes not saved come first; a team never saved has no
// file yet and can be renamed with its changes.
it('waits for changes to be saved before renaming a saved team', () => {
  renderSwitcher({ onRename: vi.fn(), saveState: 'dirty' })
  fireEvent.click(screen.getByRole('button', { name: /open team menu/ }))
  expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled()
  cleanup()
  renderSwitcher({ onRename: vi.fn(), saveState: 'new' })
  fireEvent.click(screen.getByRole('button', { name: /open team menu/ }))
  expect(screen.getByRole('button', { name: 'Rename' })).toBeEnabled()
})

it('offers no rename where the team cannot be edited', () => {
  renderSwitcher()
  fireEvent.click(screen.getByRole('button', { name: /open team menu/ }))
  expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument()
})

// ADR 0043: other teams, and a new one, are the team rail's; the chip's menu is this team's file.
it('lists no other teams and no New team', () => {
  renderSwitcher({ saveState: 'dirty' })
  fireEvent.click(screen.getByRole('button', { name: /open team menu/ }))
  const menu = screen.getByRole('dialog', { name: 'Team menu' })
  expect(within(menu).queryByRole('listbox')).not.toBeInTheDocument()
  expect(within(menu).queryByRole('textbox', { name: 'Filter teams' })).not.toBeInTheDocument()
  expect(within(menu).queryByText(/New team/)).not.toBeInTheDocument()
})

// A saved team says Saved under its name, as a saved agent does; its file is in the menu.
it('says Saved under a saved team’s name', () => {
  renderSwitcher()
  expect(screen.getByRole('button', { name: 'Trip planner, Saved, open team menu' })).toBeInTheDocument()
})

it('says nothing is left to finish on a valid saved team', () => {
  renderSwitcher()
  expect(screen.queryByText(/to finish/)).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Review' })).not.toBeInTheDocument()
})

// ADR 0043: Reload from disk and Discard both read the file again, so the menu shows one of
// them: Discard, which asks first, while there are changes; Reload otherwise.
it('offers Discard with unsaved changes and Reload from disk without, never both', () => {
  const onDiscard = vi.fn()
  renderSwitcher({ saveState: 'dirty', onDiscard })
  fireEvent.click(screen.getByRole('button', { name: /open team menu/ }))
  expect(screen.queryByRole('button', { name: 'Reload from disk' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes?' }))
  expect(onDiscard).toHaveBeenCalledOnce()
  cleanup()

  const onReload = vi.fn()
  renderSwitcher({ saveState: 'clean', onReload })
  fireEvent.click(screen.getByRole('button', { name: /open team menu/ }))
  expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Reload from disk' }))
  expect(onReload).toHaveBeenCalledOnce()
})
