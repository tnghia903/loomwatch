import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Sheet } from './Sheet'

afterEach(cleanup)

/** The sheet as Ask's card and the chat open it: over another screen, at the end of the page. */
function OverAScreen({ onClose = () => {} }: { onClose?: () => void }) {
  return (
    <>
      <button type="button">Run team</button>
      {createPortal(
        <Sheet title="Weekly update" onClose={onClose} footer={<><button type="button">Cancel</button><button type="button">Save skill</button></>}>
          <textarea aria-label="What to do" />
        </Sheet>,
        document.body,
      )}
    </>
  )
}

describe('the skill sheet over another screen', () => {
  it('keeps every key from the screen’s own shortcuts behind it, Escape still closing it', () => {
    const behind = vi.fn()
    window.addEventListener('keydown', behind)
    const onClose = vi.fn()
    try {
      render(<OverAScreen onClose={onClose} />)
      // On the canvas, Cmd+Enter starts the team's run.
      fireEvent.keyDown(screen.getByLabelText('What to do'), { key: 'Enter', metaKey: true })
      fireEvent.keyDown(screen.getByRole('button', { name: 'Save skill' }), { key: 'Backspace' })
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'j', metaKey: true })
      expect(behind).not.toHaveBeenCalled()
      fireEvent.keyDown(screen.getByLabelText('What to do'), { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(behind).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', behind)
    }
  })

  it('takes Tab round its own controls, never to the screen behind', () => {
    render(<OverAScreen />)
    const close = screen.getByRole('button', { name: 'Close' })
    const save = screen.getByRole('button', { name: 'Save skill' })
    save.focus()
    fireEvent.keyDown(save, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(save)
    // From the sheet itself, as it opens, Shift+Tab goes to its last control too.
    screen.getByRole('dialog').focus()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(save)
  })
})
