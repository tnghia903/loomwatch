import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { WorkspaceMenu } from './WorkspaceMenu'

afterEach(cleanup)

// ADR 0043: a team's ⋯ holds only what has no other control on the screen. The places are the
// dock's and About you, Connections and Usage are in You (round 3); Organize is in the view bar,
// and a routine runs from its schedule.
it('lists only what is the team’s own', () => {
  render(<WorkspaceMenu runView onMemory={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'More' }))
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
    'Team memory', 'Getting started guide', 'Send feedback…',
  ])
})

it('closes before it opens Team memory', () => {
  const onMemory = vi.fn()
  render(<WorkspaceMenu runView={false} onMemory={onMemory} />)
  fireEvent.click(screen.getByRole('button', { name: 'More' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Team memory' }))
  expect(onMemory).toHaveBeenCalledOnce()
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})

// Open over the canvas, it must not stay in the way: Escape or a click elsewhere closes it.
it('closes on Escape, back on its button, and on a click anywhere else', () => {
  render(<><WorkspaceMenu onMemory={vi.fn()} /><p>Elsewhere</p></>)
  const button = screen.getByRole('button', { name: 'More' })
  fireEvent.click(button)
  fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Team memory' }), { key: 'Escape' })
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(button).toHaveFocus()
  fireEvent.click(button)
  fireEvent.mouseDown(screen.getByRole('menuitem', { name: 'Team memory' }))
  expect(screen.getByRole('menu')).toBeInTheDocument()
  fireEvent.mouseDown(screen.getByText('Elsewhere'))
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})
