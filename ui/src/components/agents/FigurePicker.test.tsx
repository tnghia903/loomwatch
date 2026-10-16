import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Wardrobe } from '../../lib/quests/wardrobe'
import { FigurePicker } from './FigurePicker'

beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 }))))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const earned: Wardrobe = { monocle: { at: '2026-10-15T10:00:00Z', runId: 'run-1' }, scissors: { at: '2026-10-15T11:00:00Z', runId: 'run-2' } }

describe('the figure picker', () => {
  it('puts an earned item on, and takes it off again', () => {
    const onChange = vi.fn()
    const { rerender } = render(<FigurePicker figure={{ kind: 'spool', color: 'sky' }} onChange={onChange} wardrobe={earned} />)
    fireEvent.click(screen.getByRole('button', { name: /Button monocle/ }))
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'spool', color: 'sky', wear: ['monocle'] })
    rerender(<FigurePicker figure={{ kind: 'spool', color: 'sky', wear: ['monocle'] }} onChange={onChange} wardrobe={earned} />)
    expect(screen.getByRole('button', { name: /Button monocle/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: /Button monocle/ }))
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'spool', color: 'sky', wear: [] })
  })

  it('shows what is not earned yet with its hint, and lets nobody wear it', () => {
    render(<FigurePicker figure={{ kind: 'spool', color: 'sky' }} onChange={vi.fn()} wardrobe={earned} />)
    const accessories = screen.getByRole('group', { name: 'Accessories' })
    expect(within(accessories).queryByRole('button', { name: /Tailor’s tape/ })).toBeNull()
    expect(accessories).toHaveTextContent('Hint: Give an agent only the folders its job needs, not a whole drive.')
    expect(screen.getByText('1 of 7 earned, shared by all your agents')).toBeVisible()
  })

  it('offers a figure a quest earns only once it is earned', () => {
    render(<FigurePicker figure={{ kind: 'spool', color: 'sky' }} onChange={vi.fn()} wardrobe={earned} />)
    expect(screen.getByRole('radio', { name: 'Scissors' })).toBeEnabled()
    expect(screen.getByRole('radio', { name: /Bobbin, locked/ })).toBeDisabled()
  })

  it('puts shape, color and accessories side by side, open, and says where the quests are', () => {
    render(<FigurePicker figure={{ kind: 'spool', color: 'sky' }} onChange={vi.fn()} wardrobe={earned} />)
    const section = screen.getByRole('region', { name: 'Its figure' })
    expect(within(section).getByRole('group', { name: 'Shape' })).toBeVisible()
    expect(within(section).getByRole('group', { name: 'Color' })).toBeVisible()
    expect(within(section).getByRole('button', { name: /Button monocle/ })).toBeVisible()
    expect(section.querySelector('details')).toBeNull()
    expect(within(section).getByRole('link', { name: /Quests · 2 of 9 earned/ })).toHaveAttribute('href', '/quests')
  })
})
