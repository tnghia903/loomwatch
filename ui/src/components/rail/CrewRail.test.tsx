import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CrewRail, type CrewRailProps, type LeaveGuard, type RailItem } from './CrewRail'

afterEach(() => cleanup())

const item = (key: string, name: string, extra: Partial<RailItem> = {}): RailItem => ({ key, href: `/agents/${key}?view=chat`, name, presence: 'ready', current: false, art: <img alt="" />, ...extra })
const ITEMS = [
  item('researcher', 'Researcher', { detail: 'Finds sources and sums them up' }),
  item('writer', 'Writer', { detail: 'Turns notes into a clear draft', current: true }),
  item('editor', 'Editor', { detail: 'Tightens a draft', presence: 'working' }),
  item('planner', 'Trip planner', { detail: 'Plans trips day by day', presence: 'waiting' }),
]

function rail(overrides: Partial<CrewRailProps> = {}) {
  const go = vi.fn()
  render(<CrewRail label="My agents" items={ITEMS} find="Find an agent" none="No agents yet." add={{ label: 'New agent', href: '/agents/new' }} go={go} {...overrides} />)
  return { go, nav: screen.getByRole('navigation', { name: 'My agents' }) }
}

describe('CrewRail', () => {
  it('names each one with what it is doing, and marks the page you are on', () => {
    const { nav } = rail()
    expect(within(nav).getByRole('link', { name: 'Writer' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Editor, working' })).not.toHaveAttribute('aria-current')
    expect(within(nav).getByRole('link', { name: 'Trip planner, waiting for you' })).toHaveAttribute('href', '/agents/planner?view=chat')
    expect(within(nav).getByRole('link', { name: 'Trip planner, waiting for you' })).toHaveClass('waiting')
    expect(within(nav).getByRole('link', { name: 'New agent' })).toHaveAttribute('href', '/agents/new')
  })

  it('moves to another with one click, and stays put on the one you are on', () => {
    const { go, nav } = rail()
    fireEvent.click(within(nav).getByRole('link', { name: 'Editor, working' }))
    expect(go).toHaveBeenCalledWith('/agents/editor?view=chat')
    go.mockClear()
    fireEvent.click(within(nav).getByRole('link', { name: 'Writer' }))
    expect(go).not.toHaveBeenCalled()
  })

  // A click that asks for a new tab is the browser's: the page on screen stays as it is.
  it('leaves a click for a new tab to the browser', () => {
    const { go, nav } = rail()
    // ⌘ on a Mac, Ctrl elsewhere, Shift for a window. What the page did with each click is read
    // last, before jsdom would try to open a tab.
    for (const key of ['metaKey', 'ctrlKey', 'shiftKey'] as const) {
      let prevented: boolean | null = null
      const read = (event: MouseEvent) => { prevented = event.defaultPrevented; event.preventDefault() }
      document.addEventListener('click', read, { once: true })
      within(nav).getByRole('link', { name: 'Researcher' }).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, [key]: true }))
      expect(prevented, key).toBe(false)
    }
    expect(go).not.toHaveBeenCalled()
  })

  it('shows the name and state beside a figure under the pointer', () => {
    const { nav } = rail()
    fireEvent.pointerEnter(within(nav).getByRole('link', { name: 'Trip planner, waiting for you' }))
    expect(screen.getByText('Trip planner · waiting for you')).toBeInTheDocument()
    fireEvent.pointerEnter(within(nav).getByRole('link', { name: 'Researcher' }))
    expect(screen.getByText('Researcher')).toHaveClass('crew-rail-tip')
  })

  describe('finding one', () => {
    it('finds by name or by what it does, and opens the one picked with the keyboard', () => {
      const { go, nav } = rail()
      fireEvent.click(within(nav).getByRole('button', { name: 'Find an agent' }))
      const box = screen.getByRole('combobox', { name: 'Find an agent' })
      expect(box).toHaveFocus()
      expect(within(screen.getByRole('listbox', { name: 'Find an agent' })).getAllByRole('option')).toHaveLength(4)
      fireEvent.change(box, { target: { value: 'draft' } })
      const found = within(screen.getByRole('listbox', { name: 'Find an agent' })).getAllByRole('option')
      expect(found.map((option) => option.textContent)).toEqual(['WriterTurns notes into a clear draft', 'EditorTightens a draftworking'])
      fireEvent.keyDown(box, { key: 'ArrowDown' })
      fireEvent.keyDown(box, { key: 'Enter' })
      expect(go).toHaveBeenCalledWith('/agents/editor?view=chat')
      expect(screen.queryByRole('dialog', { name: 'Find an agent' })).not.toBeInTheDocument()
    })

    it('says there are none yet before anything is typed', () => {
      const { nav } = rail({ items: [] })
      fireEvent.click(within(nav).getByRole('button', { name: 'Find an agent' }))
      expect(screen.getByText('No agents yet.')).toBeInTheDocument()
    })

    it('says when nothing matches, and Escape closes it', () => {
      const { nav } = rail()
      fireEvent.click(within(nav).getByRole('button', { name: 'Find an agent' }))
      const box = screen.getByRole('combobox', { name: 'Find an agent' })
      fireEvent.change(box, { target: { value: 'zebra' } })
      expect(screen.getByText('Nothing matches “zebra”.')).toBeInTheDocument()
      fireEvent.keyDown(box, { key: 'Escape' })
      expect(screen.queryByRole('dialog', { name: 'Find an agent' })).not.toBeInTheDocument()
      expect(within(nav).getByRole('button', { name: 'Find an agent' })).toHaveFocus()
    })
  })

  describe('with changes not saved', () => {
    const guarded = (guard: Partial<LeaveGuard> = {}) => {
      const save = vi.fn(async () => true)
      const discard = vi.fn(async () => {})
      const full: LeaveGuard = { save, problem: null, discard, ...guard }
      return { ...rail({ leave: () => full }), save: full.save as typeof save, discard: full.discard as typeof discard }
    }

    it('asks before leaving, and Cancel stays', () => {
      const { go, nav } = guarded()
      fireEvent.click(within(nav).getByRole('link', { name: 'Researcher' }))
      const ask = screen.getByRole('alertdialog', { name: 'Unsaved changes' })
      expect(go).not.toHaveBeenCalled()
      fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
      expect(go).not.toHaveBeenCalled()
    })

    it('saves first, then goes', async () => {
      const { go, nav, save } = guarded()
      fireEvent.click(within(nav).getByRole('link', { name: 'Researcher' }))
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save first' })) })
      expect(save).toHaveBeenCalledOnce()
      expect(go).toHaveBeenCalledWith('/agents/researcher?view=chat')
    })

    it('stays when the save fails, so the page can say why', async () => {
      const { go, nav } = guarded({ save: vi.fn(async () => false) })
      fireEvent.click(within(nav).getByRole('link', { name: 'Researcher' }))
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save first' })) })
      expect(go).not.toHaveBeenCalled()
      expect(screen.getByRole('alertdialog', { name: 'Unsaved changes' })).toBeInTheDocument()
    })

    it('drops the changes, then goes', async () => {
      const { go, nav, discard } = guarded()
      fireEvent.click(within(nav).getByRole('link', { name: 'Researcher' }))
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Discard' })) })
      expect(discard).toHaveBeenCalledOnce()
      expect(go).toHaveBeenCalledWith('/agents/researcher?view=chat')
    })

    // A disabled button's tooltip often never shows, so the reason is in the question's words.
    it('can’t save what has a problem, and says what it is', () => {
      const { nav } = guarded({ problem: 'Give it a name.' })
      fireEvent.click(within(nav).getByRole('link', { name: 'Researcher' }))
      expect(screen.getByRole('button', { name: 'Save first' })).toBeDisabled()
      expect(screen.getByRole('alertdialog', { name: 'Unsaved changes' })).toHaveTextContent('Unsaved changes. Give it a name.')
    })

    it('asks from the find box too', () => {
      const { go, nav } = guarded()
      fireEvent.click(within(nav).getByRole('button', { name: 'Find an agent' }))
      fireEvent.click(within(screen.getByRole('listbox', { name: 'Find an agent' })).getByRole('option', { name: /Researcher/ }))
      expect(screen.getByRole('alertdialog', { name: 'Unsaved changes' })).toBeInTheDocument()
      expect(go).not.toHaveBeenCalled()
    })
  })

  it('starts a new one from the + without leaving when that is a sheet', () => {
    const onAdd = vi.fn()
    const { go, nav } = rail({ add: { label: 'New team', onAdd } })
    fireEvent.click(within(nav).getByRole('button', { name: 'New team' }))
    expect(onAdd).toHaveBeenCalledOnce()
    expect(go).not.toHaveBeenCalled()
  })
})
