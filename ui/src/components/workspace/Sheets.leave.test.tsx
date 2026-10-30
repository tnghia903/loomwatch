import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { LeaveConfirm } from './Sheets'

afterEach(cleanup)

it('asks to save, with the keyboard on Save', () => {
  const onSave = vi.fn(async () => true)
  render(<LeaveConfirm name="Scout" problem={null} onSave={onSave} onDrop={vi.fn()} onCancel={vi.fn()} />)
  const dialog = screen.getByRole('alertdialog', { name: 'Save changes to Scout?' })
  expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus()
  expect(screen.getByRole('button', { name: 'Save' })).toHaveClass('btn-ring')
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(onSave).toHaveBeenCalled()
  expect(dialog).toBeInTheDocument()
})

// The reviews: it asked "Save changes to this agent? Give it a name." beside a Save it wouldn't
// let you press, and the keyboard landed on Don't save, one Enter from losing the changes.
it('says why it can’t be saved, offers no Save, and waits on Cancel', () => {
  const onDrop = vi.fn()
  const onCancel = vi.fn()
  render(<LeaveConfirm name={null} problem="Give it a name." onSave={vi.fn(async () => true)} onDrop={onDrop} onCancel={onCancel} />)
  expect(screen.getByRole('alertdialog', { name: 'This agent can’t be saved yet. Give it a name.' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' })
  expect(onCancel).toHaveBeenCalled()
  expect(onDrop).not.toHaveBeenCalled()
})
