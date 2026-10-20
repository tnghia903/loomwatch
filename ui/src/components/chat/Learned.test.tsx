import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  it('shows nothing for work nobody learned from', () => {
    const { container } = render(<Learned lessons={[]} name={name} onUndo={vi.fn()} />)
    expect(container.innerHTML).toBe('')
  })
})
