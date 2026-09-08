import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CommandPalette } from './CommandPalette'

afterEach(cleanup)

describe('CommandPalette', () => {
  it('filters the flat action list and executes the keyboard-selected action', () => {
    const save = vi.fn()
    const close = vi.fn()
    render(
      <CommandPalette
        onClose={close}
        actions={[
          { label: 'Open team…', run: vi.fn() },
          { label: 'Save', run: save, shortcut: '⌘S' },
          { label: 'Toggle theme', run: vi.fn() },
        ]}
      />,
    )

    const input = screen.getByPlaceholderText('Type a command')
    fireEvent.change(input, { target: { value: 'sa' } })
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /open team/i })).not.toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(save).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('does not execute a disabled action', () => {
    const save = vi.fn()
    render(<CommandPalette onClose={vi.fn()} actions={[{ label: 'Save', run: save, disabled: true }]} />)

    fireEvent.keyDown(screen.getByPlaceholderText('Type a command'), { key: 'Enter' })
    expect(save).not.toHaveBeenCalled()
  })
})
