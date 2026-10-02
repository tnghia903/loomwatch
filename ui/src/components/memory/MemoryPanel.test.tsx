import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MemoryView } from '../../lib/memory/client'
import { MemoryPanel } from './MemoryPanel'

const view: MemoryView = {
  enabled: true,
  budgetChars: 8000,
  usedChars: 412,
  deliverAs: 'native-file',
  entries: [
    { path: 'brief/constraints.md', title: 'House constraints', body: '# House constraints\nNever touch main.', chars: 412, sha256: 'a'.repeat(64) },
    { path: 'brief/tone.md', title: 'Audience and tone', body: 'Be terse.', chars: 1100, sha256: 'b'.repeat(64), appliesTo: ['writer'] },
  ],
}

function panel(overrides: Partial<Parameters<typeof MemoryPanel>[0]> = {}) {
  return (
    <MemoryPanel
      teamPath="research-team.yaml" view={view} loading={false} error={null} editable
      onWriteNote={vi.fn()} onAddFile={vi.fn()} onRemove={vi.fn()} onRetry={vi.fn()} onClose={vi.fn()}
      {...overrides}
    />
  )
}

afterEach(cleanup)

describe('MemoryPanel', () => {
  it('states the budget in characters and never as a percentage of context', () => {
    render(panel())
    // The design forbids an invented occupancy meter: adapters do not report live context use,
    // so characters are the only honest figure.
    expect(screen.getByText(/fits 412 of 8.0k chars/)).toBeInTheDocument()
    expect(screen.queryByText(/%/)).not.toBeInTheDocument()
  })

  it('separates whole-team entries from scoped ones and names the scope', () => {
    render(panel())
    expect(screen.getByText('Whole team')).toBeInTheDocument()
    expect(screen.getByText(/brief\/constraints\.md · whole team · always/)).toBeInTheDocument()
    expect(screen.getByText(/brief\/tone\.md · writer only · always/)).toBeInTheDocument()
  })

  it('uses only the four sanctioned words about what an agent gets', () => {
    const { container } = render(panel())
    const text = container.textContent ?? ''
    expect(text).toContain('Supplied to each agent')
    for (const forbidden of ['the agent knows', 'remembers', 'has read']) {
      expect(text.toLowerCase()).not.toContain(forbidden)
    }
  })

  it('says what packet-only costs rather than leaving it unexplained', () => {
    render(panel({ view: { ...view, deliverAs: 'packet-only' } }))
    expect(screen.getByText(/context compaction can summarise it away/)).toBeInTheDocument()
  })

  it('writes a note and reports a write failure without losing the text', async () => {
    const onWriteNote = vi.fn().mockRejectedValue(new Error('EACCES writing brief/note.md'))
    render(panel({ onWriteNote }))
    fireEvent.click(screen.getByRole('button', { name: /write a note/i }))
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '# Rule\nNever touch main.' } })
    fireEvent.click(screen.getByRole('button', { name: /add to the brief/i }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('EACCES writing brief/note.md'))
    // The draft survives the failure: losing typed text to a failed write would be the worst
    // possible response to a permissions problem.
    expect(screen.getByRole('textbox')).toHaveValue('# Rule\nNever touch main.')
  })

  it('refuses a file that is not Markdown, before any request', () => {
    const onAddFile = vi.fn()
    render(panel({ onAddFile }))
    fireEvent.click(screen.getByRole('button', { name: /add a file/i }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'brief/notes.txt' } })
    expect(screen.getByRole('button', { name: /add to the brief/i })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'brief/notes.md' } })
    expect(screen.getByRole('button', { name: /add to the brief/i })).not.toBeDisabled()
    expect(onAddFile).not.toHaveBeenCalled()
  })

  it('backs out of a draft on Escape before it closes the panel', () => {
    const onClose = vi.fn()
    render(panel({ onClose }))
    fireEvent.click(screen.getByRole('button', { name: /write a note/i }))
    fireEvent.keyDown(screen.getByRole('region', { name: 'Memory' }), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('region', { name: 'Memory' }), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('offers the empty-state copy from the design when nothing is pinned', () => {
    render(panel({ view: { ...view, entries: [], usedChars: 0 } }))
    expect(screen.getByText('Give your team something to keep in mind.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /write a note/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add a file/i })).toBeInTheDocument()
  })

  it('reports an unreadable Brief verbatim instead of showing a short list', () => {
    render(panel({ view: null, error: 'cannot read the Brief entry brief/constraints.md' }))
    expect(screen.getByRole('alert')).toHaveTextContent('brief/constraints.md')
    expect(screen.queryByText('House constraints')).not.toBeInTheDocument()
  })

  // docs/TEAM_MEMORY.md "During a run": editing an entry is what the mid-run strip reports, so
  // there has to be a way to edit one. It rewrites the file the team file already names.
  it('rewrites one entry in place, with the body it already has', async () => {
    const onEditNote = vi.fn(async () => {})
    render(panel({ onEditNote }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0])

    const field = screen.getByRole('textbox', { name: 'Edit House constraints' })
    expect(field).toHaveValue('# House constraints\nNever touch main.')
    // The one thing this editor must not imply: that the save reaches a running agent.
    expect(screen.getByText(/read once, at the start of a run/)).toBeInTheDocument()
    expect(screen.getByText(/lands at the next session start/)).toBeInTheDocument()

    fireEvent.change(field, { target: { value: '# House constraints\nNever touch main. British spelling.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save this entry' }))
    await waitFor(() => expect(onEditNote).toHaveBeenCalledWith('brief/constraints.md', '# House constraints\nNever touch main. British spelling.\n'))
    // No team-file change: the entry is already there, so there is nothing to save twice.
    expect(screen.queryByText(/gains the entry as an unsaved change/)).not.toBeInTheDocument()
  })

  it('offers no Edit when there is nowhere to write it', () => {
    render(panel())
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  })

  it('disables editing when the document cannot be edited', () => {
    render(panel({ editable: false }))
    expect(screen.getByRole('button', { name: /write a note/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /add a file/i })).toBeDisabled()
  })

  // "Add to the Brief" writes the file at once but the entry joins the team only on save. The
  // panel used to show nothing in between, so a note looked like it had vanished.
  it('lists a note that is not saved yet and offers to save the team', () => {
    const onSaveTeam = vi.fn()
    render(panel({ unsavedEntries: ['trip.brief/budget.md'], onSaveTeam }))
    const pending = screen.getByRole('status')
    expect(pending).toHaveTextContent('Not saved yet')
    expect(pending).toHaveTextContent('trip.brief/budget.md')
    fireEvent.click(screen.getByRole('button', { name: 'Save team' }))
    expect(onSaveTeam).toHaveBeenCalledOnce()
  })

  it('says nothing about inherited entries when the team inherits none', () => {
    render(panel({ onExportPack: vi.fn() }))
    expect(screen.queryByText(/inherited entry/)).not.toBeInTheDocument()
    expect(screen.getByText('Share with another team')).toBeInTheDocument()
  })

  it('reports where an export landed, and an export failure with no draft open', async () => {
    const onExportPack = vi.fn().mockRejectedValueOnce(new Error('teams root is read-only')).mockResolvedValueOnce('research-team.memory')
    render(panel({ onExportPack }))
    fireEvent.click(screen.getByRole('button', { name: 'Export memory' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('teams root is read-only')
    fireEvent.click(screen.getByRole('button', { name: 'Export memory' }))
    expect(await screen.findByText('research-team.memory')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
