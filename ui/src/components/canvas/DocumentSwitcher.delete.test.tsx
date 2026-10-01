import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { DocumentSwitcher, type DocumentSwitcherProps } from './DocumentSwitcher'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    root: '/teams',
    files: ['trip-planner.yaml'],
    teams: [{ path: 'trip-planner.yaml', name: 'Trip planner', agentCount: 1 }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function renderSwitcher(overrides: Partial<DocumentSwitcherProps> = {}) {
  render(
    <DocumentSwitcher
      path="trip-planner.yaml" teamName="Trip planner" saveState="clean" saveError={null} linesDiffer={0}
      entrypointProblem={null} documentProblems={[]} fieldProblemsByAgent={new Map()} agentNames={new Map()} isValid
      readOnlyReason={null} onSave={vi.fn()} onSaveCopy={vi.fn()} onReload={vi.fn()} onDiscard={vi.fn()} onShowYaml={vi.fn()}
      onNewTeam={vi.fn()} onSelectProblem={vi.fn()} problemsOpen={false} onProblemsOpenChange={vi.fn()}
      {...overrides}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: /open team switcher/ }))
}

it('hands "Delete team…" to the workspace’s confirmation and closes the switcher', () => {
  const onDelete = vi.fn()
  renderSwitcher({ onDelete })
  fireEvent.click(screen.getByRole('button', { name: 'Delete team…' }))
  expect(onDelete).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('dialog', { name: 'Team switcher' })).not.toBeInTheDocument()
})

// Deleting goes back to Home, and leaving a page with unsaved edits stops on the browser's prompt.
it('holds the delete until unsaved changes are saved or discarded', () => {
  const onDelete = vi.fn()
  renderSwitcher({ onDelete, saveState: 'dirty' })
  const remove = screen.getByRole('button', { name: 'Delete team…' })
  expect(remove).toBeDisabled()
  expect(remove).toHaveAttribute('title', 'Save or discard your changes first')
  fireEvent.click(remove)
  expect(onDelete).not.toHaveBeenCalled()
})

it('offers no delete for a team that has no file yet', () => {
  renderSwitcher({ saveState: 'new' })
  expect(screen.queryByRole('button', { name: 'Delete team…' })).not.toBeInTheDocument()
})
