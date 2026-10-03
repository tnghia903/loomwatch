import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { WorkspaceMenu } from './WorkspaceMenu'

afterEach(cleanup)

// ADR 0043: the menu holds only what has no other control on the screen. All teams is the brand,
// Organize is in the view bar, Full trace in the run's heading, Show YAML in the team switcher,
// and a routine runs from its schedule.
it('lists only what no other control on the screen does', () => {
  render(<WorkspaceMenu runView onHistory={vi.fn()} onMemory={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
    'Run history', 'Team memory', 'Connections…', 'Getting started guide', 'Send feedback…',
  ])
})

it('closes before it opens Run history or Team memory', () => {
  const onHistory = vi.fn()
  const onMemory = vi.fn()
  render(<WorkspaceMenu runView={false} onHistory={onHistory} onMemory={onMemory} />)
  fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Run history' }))
  expect(onHistory).toHaveBeenCalledOnce()
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Team memory' }))
  expect(onMemory).toHaveBeenCalledOnce()
})
