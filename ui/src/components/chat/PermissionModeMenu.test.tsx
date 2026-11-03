import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PermissionModeMenu } from './PermissionModeMenu'
import { modeSays } from '../../lib/team-file/permissionMode'

afterEach(cleanup)

describe('PermissionModeMenu', () => {
  it('says which mode the team is in and switches it from a menu of two', () => {
    const onChange = vi.fn()
    render(<PermissionModeMenu mode="ask" onChange={onChange} />)
    const chip = screen.getByRole('button', { name: 'When an agent needs your OK: Ask me' })
    expect(chip).toHaveTextContent('Ask me')
    expect(chip).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(chip)
    screen.getByRole('menu', { name: 'When an agent needs your OK' })
    expect(screen.getByRole('menuitemradio', { name: /Ask me/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('menuitemradio', { name: /Auto/ })).toHaveTextContent(modeSays('auto'))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Auto/ }))
    expect(onChange).toHaveBeenCalledWith('auto')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('shows Auto as the mode it is in', () => {
    render(<PermissionModeMenu mode="auto" onChange={vi.fn()} />)
    const chip = screen.getByRole('button', { name: 'When an agent needs your OK: Auto' })
    expect(chip).toHaveClass('mode-auto')
  })

  it('does not report choosing the mode the team is already in', () => {
    const onChange = vi.fn()
    render(<PermissionModeMenu mode="auto" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Auto/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Auto/ }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('moves between the two choices with the arrow keys', () => {
    render(<PermissionModeMenu mode="ask" onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Ask me/ }))
    const ask = screen.getByRole('menuitemradio', { name: /Ask me/ })
    expect(ask).toHaveFocus()
    fireEvent.keyDown(ask, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitemradio', { name: /Auto/ })).toHaveFocus()
  })

  it('closes on Escape without letting the key reach the workspace', () => {
    const outer = vi.fn()
    render(<div onKeyDown={outer}><PermissionModeMenu mode="ask" onChange={vi.fn()} /></div>)
    fireEvent.click(screen.getByRole('button', { name: /Ask me/ }))
    fireEvent.keyDown(screen.getByRole('menuitemradio', { name: /Ask me/ }), { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(outer).not.toHaveBeenCalled()
  })

  it('gives focus back to the chip when it closes, and closes when focus or a click goes elsewhere', () => {
    render(<><PermissionModeMenu mode="ask" onChange={vi.fn()} /><button type="button">Elsewhere</button></>)
    const chip = screen.getByRole('button', { name: /Ask me/ })
    fireEvent.click(chip)
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Auto/ }))
    expect(chip).toHaveFocus()
    fireEvent.click(chip)
    fireEvent.keyDown(screen.getByRole('menuitemradio', { name: /Ask me/ }), { key: 'Escape' })
    expect(chip).toHaveFocus()

    fireEvent.click(chip)
    fireEvent.blur(screen.getByRole('menuitemradio', { name: /Ask me/ }), { relatedTarget: screen.getByRole('button', { name: 'Elsewhere' }) })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    fireEvent.click(chip)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('switches when a choice is clicked in Safari, where pressing a button gives it no focus', () => {
    // WebKit blurs the focused item with no relatedTarget on mousedown, before the click lands.
    const onChange = vi.fn()
    render(<PermissionModeMenu mode="ask" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Ask me/ }))
    fireEvent.blur(screen.getByRole('menuitemradio', { name: /Ask me/ }), { relatedTarget: null })
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Auto/ }))
    expect(onChange).toHaveBeenCalledWith('auto')
  })

  it('is a statement, not a control, when the team cannot be changed from here', () => {
    render(<PermissionModeMenu mode="auto" />)
    expect(screen.getByRole('button', { name: /Auto/ })).toBeDisabled()
  })
})
