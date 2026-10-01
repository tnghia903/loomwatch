import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Note } from '../../lib/memory/client'
import { ReviewStrip } from './ReviewStrip'

function note(id: string): Note {
  return {
    id, noteKey: id, teamId: 'research-team', runId: 'run-1', authorAgentId: 'researcher',
    kind: 'finding', title: `Finding ${id}`, body: 'body', sources: [], state: 'active',
    revision: 1, revisedBy: 'researcher', createdAt: '2026-09-13T14:32:00.000Z',
  }
}

afterEach(cleanup)

describe('ReviewStrip', () => {
  it('names the run and offers review, keep-all and not-now', () => {
    render(<ReviewStrip attempt={4} notes={[note('a'), note('b'), note('c')]} onReview={vi.fn()} onKeepAll={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByText('Run 04 finished')).toBeInTheDocument()
    expect(screen.getByText(/3 new notes the next run could use/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review 3' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keep all' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument()
  })

  it('renders nothing when the run wrote no keepable notes', () => {
    const { container } = render(<ReviewStrip attempt={1} notes={[]} onReview={vi.fn()} onKeepAll={vi.fn()} onDismiss={vi.fn()} />)
    // A strip that appeared saying "0 new notes" would be an interruption with nothing behind it.
    expect(container).toBeEmptyDOMElement()
  })

  it('keeps every note on Keep all, and reports a refusal instead of claiming it worked', async () => {
    const onKeepAll = vi.fn().mockResolvedValue(undefined)
    render(<ReviewStrip attempt={1} notes={[note('a')]} onReview={vi.fn()} onKeepAll={onKeepAll} onDismiss={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Keep all' }))
    await waitFor(() => expect(onKeepAll).toHaveBeenCalledOnce())

    cleanup()
    const failing = vi.fn().mockRejectedValue(new Error('note n1 is already kept'))
    render(<ReviewStrip attempt={1} notes={[note('a')]} onReview={vi.fn()} onKeepAll={failing} onDismiss={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Keep all' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('already kept'))
  })

  it('uses the singular for one note', () => {
    render(<ReviewStrip attempt={12} notes={[note('a')]} onReview={vi.fn()} onKeepAll={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByText(/1 new note the next run could use/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review 1' })).toBeInTheDocument()
    expect(screen.getByText('Run 12 finished')).toBeInTheDocument()
  })
})
