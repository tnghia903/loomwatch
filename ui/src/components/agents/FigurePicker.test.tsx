import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Wardrobe } from '../../lib/quests/wardrobe'
import { FigurePicker } from './FigurePicker'

beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 }))))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const earned: Wardrobe = { beret: { at: '2026-10-15T10:00:00Z', runId: 'run-1' }, plum: { at: '2026-10-15T11:00:00Z', runId: 'run-2' } }

describe('the figure picker', () => {
  it('puts an earned item on, and takes it off again', () => {
    const onChange = vi.fn()
    const { rerender } = render(<FigurePicker figure={{ kind: 'tall', color: 'sky' }} onChange={onChange} wardrobe={earned} />)
    fireEvent.click(screen.getByRole('button', { name: /Beret/ }))
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'tall', color: 'sky', wear: ['beret'] })
    rerender(<FigurePicker figure={{ kind: 'tall', color: 'sky', wear: ['beret'] }} onChange={onChange} wardrobe={earned} />)
    expect(screen.getByRole('button', { name: /Beret/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: /Beret/ }))
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'tall', color: 'sky', wear: [] })
  })

  it('shows what is not earned yet with its hint, and lets nobody wear it', () => {
    render(<FigurePicker figure={{ kind: 'tall', color: 'sky' }} onChange={vi.fn()} wardrobe={earned} />)
    const accessories = screen.getByRole('group', { name: 'Accessories' })
    expect(within(accessories).queryByRole('button', { name: /Coffee to go/ })).toBeNull()
    expect(accessories).toHaveTextContent('Hint: Give an agent only the folders its job needs, not a whole drive.')
    expect(screen.getByText('1 of 7 earned, shared by all your agents')).toBeVisible()
  })

  it('wears one set of clothes at a time: putting one on takes the other off', () => {
    const onChange = vi.fn()
    const dressed: Wardrobe = { ...earned, striped_top: { at: '2026-10-16T10:00:00Z', runId: 'run-3' }, cardigan: { at: '2026-10-16T11:00:00Z', runId: 'run-4' } }
    render(<FigurePicker figure={{ kind: 'tall', color: 'sky', wear: ['striped_top', 'beret'] }} onChange={onChange} wardrobe={dressed} />)
    const clothes = screen.getByRole('group', { name: 'Clothes' })
    expect(within(clothes).getByRole('button', { name: /Striped top/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(clothes).getByRole('button', { name: /Cardigan/ }))
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'tall', color: 'sky', wear: ['cardigan', 'beret'] })
    expect(within(clothes).queryByRole('button', { name: /Trench coat/ })).toBeNull()
    expect(clothes).toHaveTextContent('Hint: Tell an agent to ask you when the brief leaves a real choice open.')
  })

  it('offers a colour a quest earns only once it is earned, for any build', () => {
    render(<FigurePicker figure={{ kind: 'tall', color: 'sky' }} onChange={vi.fn()} wardrobe={earned} />)
    expect(screen.getByRole('radio', { name: 'Plum' })).toBeEnabled()
    expect(screen.getByRole('radio', { name: /Sunset, locked/ })).toBeDisabled()
    // Every build is open to everyone: what a quest earns is a colour.
    expect(within(screen.getByRole('group', { name: 'Shape' })).getAllByRole('radio').map((radio) => (radio as HTMLInputElement).disabled)).toEqual([false, false, false, false, false, false])
  })

  it('puts shape, color and accessories side by side, open, and says where the quests are', () => {
    render(<FigurePicker figure={{ kind: 'tall', color: 'sky' }} onChange={vi.fn()} wardrobe={earned} />)
    const section = screen.getByRole('region', { name: 'Its figure' })
    expect(within(section).getByRole('group', { name: 'Shape' })).toBeVisible()
    expect(within(section).getByRole('group', { name: 'Color' })).toBeVisible()
    expect(within(section).getByRole('button', { name: /Beret/ })).toBeVisible()
    expect(section.querySelector('details')).toBeNull()
    expect(within(section).getByRole('link', { name: /Quests · 2 of 13 earned/ })).toHaveAttribute('href', '/quests')
  })
})
