import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RunHistory } from './RunHistory'

afterEach(cleanup)

function setup() {
  const onClose = vi.fn()
  render(
    <div>
      <button type="button">Elsewhere</button>
      <RunHistory entries={[]} currentId={null} loading={false} error={null} onOpen={vi.fn()} onClose={onClose} />
    </div>,
  )
  return onClose
}

// The popup used to close only on Escape, with nothing on screen saying so.
describe('RunHistory closing', () => {
  it('has a close button', () => {
    const onClose = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Close run history' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on a click anywhere else, and not on one inside it', () => {
    const onClose = setup()
    fireEvent.pointerDown(screen.getByRole('textbox', { name: 'Filter runs' }))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('still closes on Escape', () => {
    const onClose = setup()
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Filter runs' }), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
