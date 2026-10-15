import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AutoModeSwitch } from './AutoModeSwitch'

afterEach(cleanup)

describe('AutoModeSwitch', () => {
  it('says which mode the team is in and switches it from a menu of two', () => {
    const onChange = vi.fn()
    render(<AutoModeSwitch mode="ask" onChange={onChange} />)
    const chip = screen.getByRole('button', { name: /Commands · Ask me/ })
    expect(chip).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(chip)
    const menu = screen.getByRole('menu', { name: 'When an agent wants to run a command' })
    expect(menu).toHaveTextContent('Scripts, deleting, pushing, publishing and admin commands always ask you')
    expect(screen.getByRole('menuitemradio', { name: /Ask me/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Auto/ }))
    expect(onChange).toHaveBeenCalledWith('auto')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('does not report choosing the mode the team is already in', () => {
    const onChange = vi.fn()
    render(<AutoModeSwitch mode="auto" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Commands · Auto/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Auto/ }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('moves between the two choices with the arrow keys', () => {
    render(<AutoModeSwitch mode="ask" onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Commands · Ask me/ }))
    const ask = screen.getByRole('menuitemradio', { name: /Ask me/ })
    expect(ask).toHaveFocus()
    fireEvent.keyDown(ask, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitemradio', { name: /Auto/ })).toHaveFocus()
  })

  it('closes on Escape without letting the key reach the workspace', () => {
    const outer = vi.fn()
    render(<div onKeyDown={outer}><AutoModeSwitch mode="ask" onChange={vi.fn()} /></div>)
    fireEvent.click(screen.getByRole('button', { name: /Commands · Ask me/ }))
    fireEvent.keyDown(screen.getByRole('menuitemradio', { name: /Ask me/ }), { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(outer).not.toHaveBeenCalled()
  })

  it('is a statement, not a control, when the team cannot be changed from here', () => {
    render(<AutoModeSwitch mode="auto" />)
    expect(screen.getByRole('button', { name: /Commands · Auto/ })).toBeDisabled()
  })
})
