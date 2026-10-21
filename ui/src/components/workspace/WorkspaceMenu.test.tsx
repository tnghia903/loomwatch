import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { WorkspaceMenu } from './WorkspaceMenu'

afterEach(cleanup)

// ADR 0043: the menu holds only what has no other control on the screen. All teams is the brand,
// Organize is in the view bar, and a routine runs from its schedule. Past work is in each team's chat (ADR 0051), so the run
// history list it used to open is gone. About you (ADR 0074) has no control on a team's screen.
it('lists only what no other control on the screen does', () => {
  render(<WorkspaceMenu runView onMemory={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
    'Team memory', 'My agents…', 'About you…', 'Connections…', 'Usage…', 'Getting started guide', 'Send feedback…',
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

// Open over Home's first screenful, it must not stay in the way: Escape or a click elsewhere closes it.
it('closes on Escape, back on its button, and on a click anywhere else', () => {
  render(<><WorkspaceMenu screen="home" /><p>Elsewhere</p></>)
  const button = screen.getByRole('button', { name: 'Menu' })
  fireEvent.click(button)
  fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Usage…' }), { key: 'Escape' })
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(button).toHaveFocus()
  fireEvent.click(button)
  fireEvent.mouseDown(screen.getByRole('menuitem', { name: 'Usage…' }))
  expect(screen.getByRole('menu')).toBeInTheDocument()
  fireEvent.mouseDown(screen.getByText('Elsewhere'))
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})
