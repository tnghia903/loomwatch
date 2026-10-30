import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { draftFromJob } from '../../lib/library/draft'
import type { RunRecord } from '../../lib/runs/client'
import { AgentTile } from './AgentTile'

afterEach(cleanup)

const writer = draftFromJob({ name: 'Writer', does: 'Writes the first draft', instructions: 'Write.', model: 'anthropic/claude-opus-5.5', skills: ['house-style'], allow: { web: true } })
const ownChat = (status: RunRecord['status'], waitingOn: RunRecord['waitingOn'] = null) => ({
  runId: 'r1', sessionId: 'r1', teamPath: '/teams/.jobs/.bench/writer.yaml', prompt: '', status, mode: 'pipeline', entrypoint: 'writer', responder: 'writer',
  agentIds: ['writer'], createdAt: '2026-10-30T09:00:00Z', startedAt: '2026-10-30T09:00:00Z', finishedAt: null, error: null, exitCode: null, waitingOn,
}) as RunRecord

it('says its switches as marks, solid when allowed and dashed when it asks you, then its skills and teams', () => {
  render(<AgentTile id="writer" draft={writer} teams={2} runs={[]} />)
  expect(screen.getByText('Writer')).toBeInTheDocument()
  // What it does, as the card always said; its model is said to a screen reader, and in the card's tooltip.
  expect(screen.getByText('Writes the first draft')).toHaveClass('agent-tile-does')
  expect(screen.getByText('on Claude Opus 5.5')).toHaveClass('visually-hidden')
  expect(screen.getByRole('img', { name: 'Search the web: allowed' })).toHaveClass('on')
  // Shape, not colour: an allowed switch carries a check, one that asks has none.
  expect(screen.getByRole('img', { name: 'Search the web: allowed' }).querySelector('.agent-tile-check')).not.toBeNull()
  expect(screen.getByRole('img', { name: 'Edit files: asks you' }).querySelector('.agent-tile-check')).toBeNull()
  expect(screen.getByRole('img', { name: 'Edit files: asks you' })).toHaveClass('asks')
  expect(screen.getByRole('img', { name: 'Run commands: asks you' })).toHaveClass('asks')
  expect(screen.getByRole('img', { name: '1 skill' })).toHaveTextContent('1')
  expect(screen.getByRole('img', { name: 'In 2 teams' })).toHaveTextContent('2')
  // Ready says nothing: it is how an agent rests.
  expect(document.querySelector('.agent-tile-state')).toBeNull()
  expect(document.querySelector('.agent-tile-figure')).toHaveAttribute('data-glow', 'ready')
})

it('lights its figure and says what it is doing in its own chat', () => {
  render(<AgentTile id="writer" draft={writer} teams={0} runs={[ownChat('running', { node: 'writer', name: 'Writer', kind: 'question', since: '2026-10-30T09:01:00Z', question: 'Which tone?' } as RunRecord['waitingOn'])]} />)
  expect(document.querySelector('.agent-tile-figure')).toHaveAttribute('data-glow', 'waiting')
  expect(screen.getByText('Waiting for you')).toHaveClass('agent-tile-state', 'waiting')
  expect(screen.getByRole('img', { name: 'In no team yet' })).toBeInTheDocument()
})
