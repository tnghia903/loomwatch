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

  it('wears one set of clothes at a time: putting one on takes the other off', () => {
    const onChange = vi.fn()
    const dressed: Wardrobe = { ...earned, tee: { at: '2026-10-16T10:00:00Z', runId: 'run-3' }, overalls: { at: '2026-10-16T11:00:00Z', runId: 'run-4' } }
    render(<FigurePicker figure={{ kind: 'spool', color: 'sky', wear: ['tee', 'monocle'] }} onChange={onChange} wardrobe={dressed} />)
    const clothes = screen.getByRole('group', { name: 'Clothes' })
    expect(within(clothes).getByRole('button', { name: /Plain tee/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(clothes).getByRole('button', { name: /Work overalls/ }))
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'spool', color: 'sky', wear: ['overalls', 'monocle'] })
    expect(within(clothes).queryByRole('button', { name: /Crew vest/ })).toBeNull()
    expect(clothes).toHaveTextContent('Hint: Tell an agent to ask you when the brief leaves a real choice open.')
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
    expect(within(section).getByRole('link', { name: /Quests · 2 of 13 earned/ })).toHaveAttribute('href', '/quests')
  })
})
