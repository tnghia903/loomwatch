import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { AgentMark } from '../../components/ui/AgentMark'
import { markPattern, markState, stitchCell } from './mark'

afterEach(cleanup)

describe('markPattern', () => {
  it('gives one agent one swatch, every time', () => {
    expect(markPattern('researcher')).toEqual(markPattern('researcher'))
  })

  it('always shows both threads, so the swatch reads as cloth', () => {
    for (const id of ['a', 'writer', 'codex', 'codex-2', 'collector', 'editor', 'review', 'x'.repeat(40)]) {
      const overs = markPattern(id).over.filter(Boolean).length
      expect(overs).toBeGreaterThanOrEqual(3)
      expect(overs).toBeLessThanOrEqual(6)
    }
  })

  it('tells similar ids on one team apart', () => {
    const team = ['codex', 'codex-2', 'collector', 'editor', 'writer', 'researcher', 'reviewer', 'designer']
    const swatches = new Set(team.map((id) => markPattern(id).over.join('')))
    expect(swatches.size).toBe(team.length)
  })
})

describe('markState', () => {
  it('reads only the recorded state', () => {
    expect(markState(null)).toBe('still')
    expect(markState({ status: 'idle' })).toBe('turn')
    expect(markState({ status: 'running', taskState: 'THINKING' })).toBe('thinking')
    expect(markState({ status: 'running', taskState: 'STREAMING' })).toBe('writing')
    expect(markState({ status: 'running', taskState: 'RUNNING' })).toBe('working')
    expect(markState({ status: 'waiting' })).toBe('waiting')
    expect(markState({ status: 'succeeded' })).toBe('done')
    expect(markState({ status: 'unavailable' })).toBe('failed')
  })

  it('walks the stitch across the swatch as events arrive', () => {
    const cells = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9].map((events) => stitchCell(5, events)))
    expect(cells.size).toBe(9)
  })
})

describe('AgentMark', () => {
  it('lays a stitch for a new event only while the run is live', () => {
    const { container, rerender } = render(<AgentMark id="researcher" state="working" events={3} />)
    expect(container.querySelector('.mk-stitch')).not.toBeNull()
    rerender(<AgentMark id="researcher" state="working" events={3} animate={false} />)
    expect(container.querySelector('.mk-stitch')).toBeNull()
    rerender(<AgentMark id="researcher" state="done" events={3} />)
    expect(container.querySelector('.mk-stitch')).toBeNull()
    expect(container.querySelector('.mk-knot')).not.toBeNull()
  })

  it('breaks a thread when the agent failed, and says so', () => {
    const { container, getByRole } = render(<AgentMark id="writer" name="Writer" state="failed" />)
    expect(container.querySelector('.mk-break')).not.toBeNull()
    expect(getByRole('img', { name: 'Writer, stopped with a problem' })).toBeInTheDocument()
  })

  it('gives the review step a ring, with a halo while it waits for you', () => {
    const { container } = render(<AgentMark id="review" operator state="waiting" />)
    expect(container.querySelector('.mk-ring')).not.toBeNull()
    expect(container.querySelector('.mk-halo')).not.toBeNull()
    expect(container.querySelector('.mk-row')).toBeNull()
  })

  it('is decorative when it has nothing to say', () => {
    const { container } = render(<AgentMark id="researcher" />)
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })
})
