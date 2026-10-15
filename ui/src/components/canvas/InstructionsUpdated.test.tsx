import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removedSource } from '../../lib/team-file/mentions'
import { InstructionUpdateBar } from '../workspace/InstructionUpdateBar'
import type { InstructionUpdate } from '../workspace/useInstructionUpdates'
import { InstructionsUpdated } from './InstructionsUpdated'

afterEach(cleanup)

const ekis = removedSource({ id: 'notion@807', kind: 'knowledge', name: 'EKIS — SUTD Final Project Hub', notion: { page: '807' } })
const BEFORE = 'Establish the problem from the EKIS Notion page and the run request. Reply with a brief.'
const AFTER = 'Establish the problem from the run request. Reply with a brief.'
const update = (extra: Partial<InstructionUpdate> = {}): InstructionUpdate => ({ agentId: 'scope', source: ekis, before: BEFORE, after: AFTER, state: 'updated', ...extra })

describe('InstructionsUpdated', () => {
  it('shows what LoomWatch took out of the instructions and why, and keeps or puts back on request', () => {
    const onKeep = vi.fn()
    const onPutBack = vi.fn()
    const { container } = render(<InstructionsUpdated update={update()} agent={{ role: AFTER }} onKeep={onKeep} onPutBack={onPutBack} />)
    expect(screen.getByRole('region', { name: 'What LoomWatch changed in these instructions' })).toHaveTextContent('Updated because you removed the Notion page “EKIS — SUTD Final Project Hub”')
    expect([...container.querySelectorAll('.instructions-diff del')].map((node) => node.textContent)).toEqual(['EKIS Notion page and the '])
    expect(container.querySelectorAll('.instructions-diff ins')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    fireEvent.click(screen.getByRole('button', { name: 'Put back the old instructions' }))
    expect(onKeep).toHaveBeenCalledTimes(1)
    expect(onPutBack).toHaveBeenCalledTimes(1)
  })

  it('compares with the instructions as they are now, after the operator edits them', () => {
    const { container } = render(<InstructionsUpdated update={update()} agent={{ role: `${AFTER} Cite sources.` }} onKeep={vi.fn()} onPutBack={vi.fn()} />)
    expect([...container.querySelectorAll('.instructions-diff ins')].map((node) => node.textContent)).toEqual([' Cite sources.'])
  })

  it('quotes the sentences that still name it, before any rewrite and after a failed one', () => {
    const { unmount } = render(<InstructionsUpdated update={update({ state: 'stale', after: null })} agent={{ role: BEFORE }} onKeep={vi.fn()} onPutBack={vi.fn()} />)
    expect(screen.getByRole('region', { name: 'Instructions that still name what you removed' })).toHaveTextContent('These instructions still name the Notion page “EKIS — SUTD Final Project Hub”, which you removed.')
    expect(screen.getByRole('button', { name: 'Keep as is' })).toBeInTheDocument()
    unmount()

    render(<InstructionsUpdated update={update({ state: 'failed', after: null, error: 'Claude Code stopped answering.' })} agent={{ role: BEFORE }} onKeep={vi.fn()} onPutBack={vi.fn()} />)
    const region = screen.getByRole('region', { name: 'Instructions that still name what you removed' })
    expect(region).toHaveTextContent('Claude Code stopped answering.')
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Establish the problem from the EKIS Notion page and the run request.'])
    expect(screen.queryByRole('button', { name: 'Put back the old instructions' })).toBeNull()
  })

  it('offers nothing to press on a team that cannot be changed', () => {
    render(<InstructionsUpdated update={update()} agent={{ role: AFTER }} readOnly onKeep={vi.fn()} onPutBack={vi.fn()} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})

describe('InstructionUpdateBar', () => {
  const names = new Map([['scope', 'Project scope'], ['plan', 'Plan writer']])

  it('says LoomWatch is rewriting, then what it updated, with a way to review each and keep them all', () => {
    const working = [update({ state: 'working', after: null }), update({ agentId: 'plan', state: 'working', after: null })]
    const { rerender } = render(<InstructionUpdateBar entries={working} names={names} onReview={vi.fn()} onKeepAll={vi.fn()} onRewrite={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Rewriting the instructions of 2 agents without the Notion page “EKIS — SUTD Final Project Hub”, which you removed…')
    expect(screen.queryAllByRole('button')).toHaveLength(0)

    const onReview = vi.fn()
    const onKeepAll = vi.fn()
    rerender(<InstructionUpdateBar entries={[update()]} names={names} onReview={onReview} onKeepAll={onKeepAll} onRewrite={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent("Updated Project scope's instructions because you removed the Notion page")
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep all' }))
    expect(onReview).toHaveBeenCalledWith('scope')
    expect(onKeepAll).toHaveBeenCalledTimes(1)
  })

  it('says which instructions still name it and offers a rewrite by the Ask app, or none without one', () => {
    const onRewrite = vi.fn()
    const stale = [update({ state: 'stale', after: null }), update({ agentId: 'plan', state: 'stale', after: null })]
    const { rerender } = render(<InstructionUpdateBar entries={stale} names={names} onReview={vi.fn()} onKeepAll={vi.fn()} onRewrite={onRewrite} rewriteWith="Claude Code" />)
    expect(screen.getByRole('status')).toHaveTextContent('The instructions of 2 agents still name the Notion page “EKIS — SUTD Final Project Hub”, which you removed.')
    fireEvent.click(screen.getByRole('button', { name: 'Rewrite with Claude Code' }))
    expect(onRewrite).toHaveBeenCalledTimes(1)

    rerender(<InstructionUpdateBar entries={stale} names={names} onReview={vi.fn()} onKeepAll={vi.fn()} />)
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Review'])
  })

  it('says why a rewrite failed and offers to try again', () => {
    const onRewrite = vi.fn()
    render(<InstructionUpdateBar entries={[update({ state: 'failed', after: null, error: 'Claude Code stopped answering.' })]} names={names} onReview={vi.fn()} onKeepAll={vi.fn()} onRewrite={onRewrite} />)
    expect(screen.getByRole('status')).toHaveTextContent("Project scope's instructions still name the Notion page “EKIS — SUTD Final Project Hub”, which you removed. Claude Code stopped answering.")
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRewrite).toHaveBeenCalledTimes(1)
  })
})
