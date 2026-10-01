import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { CheckpointStrip } from './CheckpointStrip'
import type { Checkpoint } from '../../lib/memory/client'

afterEach(cleanup)

const checkpoint = (overrides: Partial<Checkpoint> = {}): Checkpoint => ({
  id: 'cp-1',
  runId: 'run-3',
  agentId: 'writer',
  invocation: 0,
  done: 'Sections 1-3 drafted.',
  next: 'Section 4.',
  artifacts: [],
  source: 'agent',
  ts: '2026-09-13T14:40:00.000Z',
  ...overrides,
})

const names = new Map([['writer', 'Technical Writer']])

/**
 * The label is the design's, verbatim: **"Start a new run from this checkpoint"**, never "Resume".
 *
 * Not a matter of tone. Nothing here reattaches to the stopped run's processes and nothing
 * reconciles the side effects it had already caused, so "Resume" would claim two things the tree
 * cannot do. This test exists to make the word a gate rather than a note.
 */
it('offers to start a new run from the checkpoint, and never says Resume', async () => {
  const onStart = vi.fn(async () => {})
  render(
    <CheckpointStrip
      attempt={3}
      checkpoints={[checkpoint()]}
      names={names}
      onStart={onStart}
      onDismiss={vi.fn()}
    />,
  )
  expect(screen.getByText(/Run 03 stopped at Technical Writer/)).toBeInTheDocument()
  expect(screen.getByText(/Done: Sections 1-3 drafted\./)).toBeInTheDocument()
  expect(screen.getByText(/Next: Section 4\./)).toBeInTheDocument()
  expect(screen.queryByText(/Resume/i)).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Start a new run from this checkpoint' }))
  await waitFor(() => expect(onStart).toHaveBeenCalledWith('cp-1'))
})

/**
 * A `coordinator` row is not a stage's plan. Its `next` is empty because the run died before
 * anyone said, and the strip states that rather than leaving a gap that reads as "nothing left".
 */
it('says who assembled a coordinator checkpoint and that next was not recorded', () => {
  render(
    <CheckpointStrip
      attempt={3}
      checkpoints={[checkpoint({ source: 'coordinator', done: 'half of section three', next: '' })]}
      names={names}
      onStart={vi.fn(async () => {})}
      onDismiss={vi.fn()}
    />,
  )
  expect(screen.getByText(/LoomWatch recorded this from the archive/)).toBeInTheDocument()
  expect(screen.getByText(/Next: not recorded\./)).toBeInTheDocument()
})

/** The last stage to reach a boundary is where the work stopped, so it leads the strip. */
it('leads with the stage the run reached last, and carries its blockers', () => {
  render(
    <CheckpointStrip
      attempt={3}
      checkpoints={[
        checkpoint({ id: 'cp-a', agentId: 'researcher', done: 'Probed four harnesses.' }),
        checkpoint({ id: 'cp-b', agentId: 'writer', blockers: 'The pricing table.' }),
      ]}
      names={new Map([['researcher', 'Protocol Researcher'], ['writer', 'Technical Writer']])}
      onStart={vi.fn(async () => {})}
      onDismiss={vi.fn()}
    />,
  )
  expect(screen.getByText(/stopped at Technical Writer/)).toBeInTheDocument()
  expect(screen.getByText(/Blocked on: The pricing table\./)).toBeInTheDocument()
})

/** A run that left no checkpoint has nothing to offer, so the strip is absent rather than empty. */
it('renders nothing when the run left no checkpoint', () => {
  const { container } = render(
    <CheckpointStrip attempt={3} checkpoints={[]} names={names} onStart={vi.fn(async () => {})} onDismiss={vi.fn()} />,
  )
  expect(container).toBeEmptyDOMElement()
})

/** A failed start is reported in place; the strip does not silently swallow it. */
it('reports a failed start without losing the offer', async () => {
  render(
    <CheckpointStrip
      attempt={3}
      checkpoints={[checkpoint()]}
      names={names}
      onStart={vi.fn(async () => { throw new Error('the team file changed before the run could start') })}
      onDismiss={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Start a new run from this checkpoint' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('the team file changed'))
  expect(screen.getByRole('button', { name: 'Start a new run from this checkpoint' })).toBeEnabled()
})
