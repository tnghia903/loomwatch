import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Note, NotebookView } from '../../lib/memory/client'
import { NotebookTab } from './NotebookTab'

function note(overrides: Partial<Note> & Pick<Note, 'id' | 'kind' | 'title'>): Note {
  return {
    noteKey: overrides.id,
    teamId: 'research-team',
    runId: 'run-1',
    authorAgentId: 'researcher',
    body: 'The body of the note.',
    sources: [],
    state: 'active',
    revision: 1,
    revisedBy: 'researcher',
    createdAt: '2026-09-13T14:32:00.000Z',
    ...overrides,
  }
}

function view(overrides: Partial<NotebookView> = {}): NotebookView {
  return {
    teamId: 'research-team',
    enabled: true,
    keep: 'review',
    notes: [],
    inherited: [],
    inheritedTeams: [],
    ...overrides,
  }
}

function tab(overrides: Partial<Parameters<typeof NotebookTab>[0]> = {}) {
  return (
    <NotebookTab
      view={view()} loading={false} error={null} editable
      onRevise={vi.fn()} onHistory={vi.fn()} onRetry={vi.fn()}
      {...overrides}
    />
  )
}

afterEach(cleanup)

describe('NotebookTab', () => {
  it('shows a group only when it has content', () => {
    render(tab({
      view: view({
        notes: [
          note({ id: 'n1', kind: 'decision', title: 'Hermes adapter is out of scope' }),
          note({ id: 'n2', kind: 'finding', title: 'codex-acp auto-approves' }),
          note({ id: 'n3', kind: 'finding', title: 'Gemini free tier is usable' }),
        ],
      }),
    }))
    // Two groups have content and are headed with their count.
    expect(screen.getByText('Decisions')).toBeInTheDocument()
    expect(screen.getByText('Findings')).toBeInTheDocument()
    // An empty group is absent, not shown as zero: "Blockers 0" reads as a claim that blockers
    // were looked for and none found, which is not what an empty notebook means.
    expect(screen.queryByText('Open questions')).not.toBeInTheDocument()
    expect(screen.queryByText('Blockers')).not.toBeInTheDocument()
    expect(screen.queryByText('Progress')).not.toBeInTheDocument()
    // Counterfactual: a blocker makes its group appear, and nothing else changes.
    cleanup()
    render(tab({ view: view({ notes: [note({ id: 'n4', kind: 'blocker', title: 'The pricing table is missing' })] }) }))
    expect(screen.getByText('Blockers')).toBeInTheDocument()
    expect(screen.queryByText('Decisions')).not.toBeInTheDocument()
  })

  it('carries author, time and source count on every row, and never says the agent knows anything', () => {
    render(tab({
      view: view({
        notes: [note({ id: 'n1', kind: 'finding', title: 'codex-acp auto-approves', sources: ['probe.txt', 'session log'] })],
      }),
    }))
    const row = screen.getByText('codex-acp auto-approves').closest('[data-note-state]')!
    expect(row).toHaveTextContent('researcher')
    expect(row).toHaveTextContent('2 sources')
    expect(screen.queryByText(/knows|remembers|has read/i)).not.toBeInTheDocument()
    // The footer states the trust boundary in as many words.
    expect(screen.getByText(/not verified facts, and a note being supplied does not mean an agent followed it/)).toBeInTheDocument()
  })

  it('keeps a retired row visible and dimmed rather than hiding it', () => {
    render(tab({
      view: view({
        notes: [note({ id: 'n1', kind: 'finding', title: 'Gemini free tier is usable', state: 'retired', revision: 2, revisedBy: 'operator' })],
      }),
    }))
    const row = screen.getByText('Gemini free tier is usable').closest('[data-note-state]')!
    expect(row).toHaveAttribute('data-note-state', 'retired')
    expect(row).toHaveStyle({ opacity: '0.55' })
    expect(row).toHaveTextContent('retired · superseded')
    // A retired note is not offered Keep, Correct or Retire again — its history is closed.
    expect(screen.queryByRole('button', { name: 'Keep' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retire' })).not.toBeInTheDocument()
    // History stays available: that is the point of keeping it.
    expect(screen.getByRole('button', { name: 'History' })).toBeInTheDocument()
  })

  it('says who corrected a row and when', () => {
    render(tab({
      view: view({
        notes: [note({ id: 'n1', kind: 'decision', title: 'Cite archive seq numbers', revision: 2, revisedBy: 'operator' })],
      }),
    }))
    expect(screen.getByText(/corrected by you/)).toBeInTheDocument()
  })

  it('sends Keep and a correction with the revision they were written against', async () => {
    const onRevise = vi.fn().mockResolvedValue(undefined)
    render(tab({
      view: view({ notes: [note({ id: 'n1', kind: 'decision', title: 'Hermes is out of scope', revision: 3 })] }),
      onRevise,
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    await waitFor(() => expect(onRevise).toHaveBeenCalledWith('n1', 'keep', { revision: 3 }))

    fireEvent.click(screen.getByRole('button', { name: 'Correct' }))
    fireEvent.change(screen.getByLabelText('Correct the title of Hermes is out of scope'), { target: { value: 'Hermes adapter is out of scope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save the correction' }))
    await waitFor(() => expect(onRevise).toHaveBeenLastCalledWith('n1', 'correct', {
      revision: 3, title: 'Hermes adapter is out of scope', body: 'The body of the note.',
    }))
    // The draft says which revision it writes, so the operator is not guessing.
    expect(onRevise).toHaveBeenCalledTimes(2)
  })

  it('reports a refused revision instead of pretending it landed', async () => {
    const onRevise = vi.fn().mockRejectedValue(new Error('the note is at revision 4, not the revision 3 this change was written against.'))
    render(tab({
      view: view({ notes: [note({ id: 'n1', kind: 'decision', title: 'Hermes is out of scope', revision: 3 })] }),
      onRevise,
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('revision 4'))
  })

  it('shows inherited notes as read-only, with no Keep, Correct or Retire', () => {
    render(tab({
      view: view({
        inherited: [note({ id: 'i1', kind: 'decision', title: 'We ship on ACP v1 only', state: 'kept', runId: null, teamId: 'daily-news', originTeamId: 'research-team' })],
        inheritedTeams: ['research-team'],
      }),
    }))
    expect(screen.getByText('Inherited · read-only')).toBeInTheDocument()
    const row = screen.getByText('We ship on ACP v1 only').closest('[data-note-state]')!
    expect(row).toHaveTextContent('research-team')
    expect(screen.queryByRole('button', { name: 'Keep' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Correct' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retire' })).not.toBeInTheDocument()
  })

  it('says the notebook is off rather than empty when the team disabled it', () => {
    render(tab({ view: view({ enabled: false }) }))
    expect(screen.getByText(/notebook is off, so its agents are given no memory tools/)).toBeInTheDocument()
    expect(screen.queryByText(/Nothing recorded yet/)).not.toBeInTheDocument()
  })

  it('opens the full revision history on demand', async () => {
    const onHistory = vi.fn().mockResolvedValue([
      note({ id: 'n1', kind: 'decision', title: 'Seq numbers', revision: 1 }),
      note({ id: 'n2', kind: 'decision', title: 'Cite archive seq numbers', revision: 2, revisedBy: 'operator' }),
    ])
    render(tab({
      view: view({ notes: [note({ id: 'n2', kind: 'decision', title: 'Cite archive seq numbers', revision: 2, revisedBy: 'operator' })] }),
      onHistory,
    }))
    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    await waitFor(() => expect(screen.getByText(/revision 1 · active · researcher/)).toBeInTheDocument())
    expect(screen.getByText(/revision 2 · active · operator/)).toBeInTheDocument()
    expect(onHistory).toHaveBeenCalledWith('n2')
  })
})
