import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Lesson } from '../../lib/lessons/client'
import { Learned } from './Learned'

afterEach(cleanup)

const lesson = (over: Partial<Lesson> = {}): Lesson => ({
  id: 'l1',
  scope: 'team:news-desk#writer',
  agentId: 'writer',
  text: 'When writing the digest, use three bullets.',
  source: 'you',
  aboutYou: false,
  feedback: 'Too long. Three bullets, please.',
  runId: 'run-1',
  state: 'active',
  given: 0,
  backed: 0,
  missed: 0,
  createdAt: '2026-10-20T08:00:00.000Z',
  updatedAt: '2026-10-20T08:00:00.000Z',
  ...over,
})

const name = (id: string) => ({ writer: 'Writer', checker: 'Checker' })[id] ?? id

describe('Learned', () => {
  it('says who learned what from this work, and where it came from', () => {
    render(<Learned lessons={[lesson(), lesson({ id: 'l2', source: 'check', feedback: 'Cites the 2025 report (the check found: cites the 2023 one)', text: 'When citing a report, cite its newest edition.' })]} name={name} />)
    const lines = screen.getAllByText(/learned:/)
    expect(lines.map((line) => line.textContent)).toEqual([
      'Writer learned: When writing the digest, use three bullets.',
      'Writer learned: When citing a report, cite its newest edition.',
    ])
    expect(lines[0].closest('p')?.getAttribute('title')).toBe('From what you said: Too long. Three bullets, please.')
    expect(lines[1].closest('p')?.getAttribute('title')).toMatch(/^From the check: Cites the 2025 report/)
    cleanup()
    render(<Learned lessons={[lesson({ source: 'liked', feedback: 'You marked this answer Love it.' })]} name={name} />)
    expect(screen.getByText(/learned:/).closest('p')?.getAttribute('title')).toBe('From your Love it: You marked this answer Love it.')
    // Nothing to take back where nothing can be taken back.
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('takes a lesson back with Undo, and says why when it cannot', async () => {
    const onUndo = vi.fn().mockRejectedValueOnce(new Error('That lesson is not kept any more.')).mockResolvedValueOnce(undefined)
    render(<Learned lessons={[lesson()]} name={name} onUndo={onUndo} />)
    const undo = screen.getByRole('button', { name: 'Undo: When writing the digest, use three bullets.' })
    fireEvent.click(undo)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('That lesson is not kept any more.'))
    fireEvent.click(undo)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(onUndo).toHaveBeenCalledTimes(2)
    expect(onUndo.mock.calls[0][0].id).toBe('l1')
  })

  const vietnamese = 'When replying to this person, always write in Vietnamese.'

  it('offers Tell all my agents only on a lesson about you, and asks before anything is written', async () => {
    const onTellAll = vi.fn().mockResolvedValue(undefined)
    const onUndo = vi.fn()
    render(<Learned lessons={[lesson(), lesson({ id: 'l2', aboutYou: true, text: vietnamese, feedback: 'In Vietnamese, please.' })]} name={name} onUndo={onUndo} onTellAll={onTellAll} />)
    const tell = screen.getAllByRole('button', { name: /^Tell all my agents/ })
    expect(tell.map((button) => button.getAttribute('aria-label'))).toEqual([`Tell all my agents: ${vietnamese}`])
    // Pressing it only asks.
    fireEvent.click(tell[0])
    expect(onTellAll).not.toHaveBeenCalled()
    const ask = screen.getByRole('group', { name: 'Tell all my agents' })
    expect(ask.textContent).toContain('Add to About you, so every agent does this?')
    expect(tell[0].getAttribute('aria-expanded')).toBe('true')
    // The keyboard goes to the question, and back when it is put away.
    expect(document.activeElement).toBe(within(ask).getByRole('button', { name: 'Add' }))
    expect(screen.queryByRole('button', { name: `Undo: ${vietnamese}` })).toBeNull()
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('group', { name: 'Tell all my agents' })).toBeNull()
    expect(document.activeElement).toBe(tell[0])
    expect(onTellAll).not.toHaveBeenCalled()
    fireEvent.click(tell[0])
    fireEvent.keyDown(screen.getByRole('button', { name: 'Add' }), { key: 'Escape' })
    expect(screen.queryByRole('group', { name: 'Tell all my agents' })).toBeNull()
    expect(onTellAll).not.toHaveBeenCalled()
    // Asked again, and Add: now it is told.
    fireEvent.click(screen.getByRole('button', { name: `Tell all my agents: ${vietnamese}` }))
    fireEvent.click(within(screen.getByRole('group', { name: 'Tell all my agents' })).getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(onTellAll).toHaveBeenCalledTimes(1))
    expect(onTellAll.mock.calls[0][0].id).toBe('l2')
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Tell all my agents' })).toBeNull())
    expect(onUndo).not.toHaveBeenCalled()
  })

  it('puts the keyboard on the moved line’s Undo once the chat reads again, and back on Tell all my agents after it', async () => {
    const active = lesson({ aboutYou: true, text: vietnamese })
    const moved = { ...active, state: 'dropped' as const, droppedBy: 'about_you' as const }
    const { rerender } = render(<Learned lessons={[active]} name={name} onUndo={vi.fn().mockResolvedValue(undefined)} onTellAll={vi.fn().mockResolvedValue(undefined)} />)
    fireEvent.click(screen.getByRole('button', { name: `Tell all my agents: ${vietnamese}` }))
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Tell all my agents' })).toBeNull())
    rerender(<Learned lessons={[moved]} name={name} onUndo={vi.fn().mockResolvedValue(undefined)} onTellAll={vi.fn()} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: `Undo: ${vietnamese}` }))
    fireEvent.click(screen.getByRole('button', { name: `Undo: ${vietnamese}` }))
    await waitFor(() => expect(screen.queryByRole('button', { name: `Undo: ${vietnamese}` })).toBeNull())
    rerender(<Learned lessons={[active]} name={name} onUndo={vi.fn()} onTellAll={vi.fn()} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: `Tell all my agents: ${vietnamese}` }))
  })

  it('keeps the question open and says why when About you cannot take it', async () => {
    const onTellAll = vi.fn().mockRejectedValue(new Error('About you is full. Make room on the About you page, then try again.'))
    render(<Learned lessons={[lesson({ aboutYou: true, text: vietnamese })]} name={name} onUndo={vi.fn()} onTellAll={onTellAll} />)
    fireEvent.click(screen.getByRole('button', { name: `Tell all my agents: ${vietnamese}` }))
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('About you is full. Make room on the About you page, then try again.'))
    expect(screen.getByRole('group', { name: 'Tell all my agents' })).toBeTruthy()
  })

  it('says all your agents know a lesson moved to About you, and its Undo moves it back', async () => {
    const onUndo = vi.fn().mockResolvedValue(undefined)
    const onTellAll = vi.fn()
    const moved = lesson({ aboutYou: true, text: vietnamese, feedback: 'In Vietnamese, please.', state: 'dropped', droppedBy: 'about_you' })
    render(<Learned lessons={[moved]} name={name} onUndo={onUndo} onTellAll={onTellAll} />)
    const line = screen.getByText(/know:/)
    expect(line.textContent).toBe(`All your agents know: ${vietnamese}`)
    expect(line.closest('p')?.getAttribute('title')).toBe('In About you, for all your agents. From what you said: In Vietnamese, please.')
    expect(screen.queryByRole('button', { name: /^Tell all my agents/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: `Undo: ${vietnamese}` }))
    await waitFor(() => expect(onUndo).toHaveBeenCalledTimes(1))
    expect(onUndo.mock.calls[0][0]).toBe(moved)
    expect(onTellAll).not.toHaveBeenCalled()
  })

  it('shows a lesson’s Markdown on its line, and reads it as words in its buttons and tooltip', async () => {
    const marked = lesson({ aboutYou: true, text: 'Write the **digest** with `three` bullets.', feedback: 'Too **long**.' })
    render(<Learned lessons={[marked]} name={name} onUndo={vi.fn()} onTellAll={vi.fn()} />)
    expect(await screen.findByText('digest', { selector: 'strong' })).toBeTruthy()
    expect(screen.getByText('three', { selector: 'code' })).toBeTruthy()
    const line = screen.getByText(/learned:/)
    expect(line.textContent).toBe('Writer learned: Write the digest with three bullets.')
    expect(line.closest('p')?.getAttribute('title')).toBe('From what you said: Too long.')
    expect(screen.getByRole('button', { name: 'Undo: Write the digest with three bullets.' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Tell all my agents: Write the digest with three bullets.' })).toBeTruthy()
  })

  it('shows nothing for work nobody learned from', () => {
    const { container } = render(<Learned lessons={[]} name={name} onUndo={vi.fn()} />)
    expect(container.innerHTML).toBe('')
  })
})
