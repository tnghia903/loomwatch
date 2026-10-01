// docs/TEAM_MEMORY.md → "The Memory panel", During a run: "Editing the Brief mid-run never
// claims to interrupt a live turn: a strip says exactly when the change lands and who still
// holds the old revision."
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BriefEditStrip } from './BriefEditStrip'

afterEach(cleanup)

const editedAt = new Date('2026-09-13T14:44:00')
const suppliedAt = new Date('2026-09-13T14:20:00')

describe('BriefEditStrip', () => {
  it('says when the change lands and who still holds the old revision', () => {
    render(<BriefEditStrip title="House constraints" editedAt={editedAt} holderName="Reviewer" suppliedAt={suppliedAt} onDismiss={vi.fn()} />)
    const strip = screen.getByRole('status')
    expect(strip).toHaveTextContent('Edited House constraints at 14:44')
    expect(strip).toHaveTextContent('available at the next session start')
    expect(strip).toHaveTextContent('Reviewer still has the 14:20 version')
  })

  it('never claims a live turn was interrupted, stopped or reloaded', () => {
    render(<BriefEditStrip title="House constraints" editedAt={editedAt} holderName="Reviewer" suppliedAt={suppliedAt} onDismiss={vi.fn()} />)
    const text = screen.getByRole('status').textContent ?? ''
    expect(text).not.toMatch(/interrupt|stopped|restart|reload|cancel|paused/i)
    // Nor any of the three words the copy rules forbid about what an agent has.
    expect(text).not.toMatch(/knows|remembers|has read/i)
  })

  it('still names the revision when the run has no recorded start time', () => {
    render(<BriefEditStrip title="Audience and tone" editedAt={editedAt} holderName="Writer" suppliedAt={null} onDismiss={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Writer still has the revision this run started with')
  })

  it('is dismissible, because it is a notice rather than a blocker', () => {
    const onDismiss = vi.fn()
    render(<BriefEditStrip title="House constraints" editedAt={editedAt} holderName="Reviewer" suppliedAt={suppliedAt} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss this notice' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
