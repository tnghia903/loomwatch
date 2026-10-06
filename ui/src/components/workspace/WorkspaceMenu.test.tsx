import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { WorkspaceMenu } from './WorkspaceMenu'

afterEach(cleanup)

// ADR 0043: the menu holds only what has no other control on the screen. All teams is the brand,
// Organize is in the view bar, Full trace in the run's heading, Show YAML in the team switcher,
// and a routine runs from its schedule. Past work is in each team's chat (ADR 0051), so the run
// history list it used to open is gone.
it('lists only what no other control on the screen does', () => {
  render(<WorkspaceMenu runView onMemory={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
    'Team memory', 'Connections…', 'Getting started guide', 'Send feedback…',
  ])
})

it('closes before it opens Team memory', () => {
  const onMemory = vi.fn()
  render(<WorkspaceMenu runView={false} onMemory={onMemory} />)
  fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Team memory' }))
  expect(onMemory).toHaveBeenCalledOnce()
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})
