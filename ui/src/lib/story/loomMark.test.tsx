import { act, render, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LoomMark } from '../../components/ui/glyphs'
import type { RunRecord, RunStatus } from '../runs/client'
import { FINISHED_FOR_MS, loomMarkPose, loomMarkState, runsJustFinished, useLoomMarkState, type LoomMarkState } from './loomMark'

function run(id: string, status: RunStatus): RunRecord {
  return { runId: id, sessionId: id, teamPath: 'digest.yaml', prompt: '', status, mode: 'pipeline', entrypoint: 'a', responder: 'b', agentIds: [], createdAt: '2026-10-16T03:00:00Z', startedAt: null, finishedAt: null, error: null, exitCode: null, eventCount: 0, reply: null }
}

describe('loomMarkState', () => {
  it('is ready when nothing runs and nothing waits', () => {
    expect(loomMarkState({ waiting: 0, working: 0, finished: false })).toBe('ready')
  })

  it('puts you first, then a running team, then a run just done', () => {
    expect(loomMarkState({ waiting: 1, working: 3, finished: true })).toBe('asking')
    expect(loomMarkState({ waiting: 0, working: 1, finished: true })).toBe('running')
    expect(loomMarkState({ waiting: 0, working: 0, finished: true })).toBe('finished')
  })
})

describe('loomMarkPose', () => {
  it('holds still with no glow when ready', () => {
    expect(loomMarkPose('ready')).toEqual({ glance: false, mouth: 'stitch', blink: false, glow: 'none', breathe: false })
  })

  it('glances with the crew’s breathing blue glow while a team runs', () => {
    expect(loomMarkPose('running')).toEqual({ glance: true, mouth: 'stitch', blink: false, glow: 'live', breathe: true })
  })

  it('opens its mouth to a gold "o" and glows gold, held still, when something needs you', () => {
    expect(loomMarkPose('asking')).toEqual({ glance: false, mouth: 'o', blink: false, glow: 'you', breathe: false })
  })

  it('blinks once with no glow when a run is done', () => {
    expect(loomMarkPose('finished')).toEqual({ glance: false, mouth: 'stitch', blink: true, glow: 'none', breathe: false })
  })

  it('never moves under reduced motion, but keeps the glow and the mouth', () => {
    const states: LoomMarkState[] = ['ready', 'running', 'asking', 'finished']
    for (const state of states) {
      const pose = loomMarkPose(state, { reducedMotion: true })
      expect(pose, state).toMatchObject({ glance: false, blink: false, breathe: false })
      expect(pose.glow, state).toBe(loomMarkPose(state).glow)
      expect(pose.mouth, state).toBe(loomMarkPose(state).mouth)
    }
  })
})

describe('runsJustFinished', () => {
  it('names runs seen live that have since ended, however they ended', () => {
    const before = [run('a', 'running'), run('b', 'starting'), run('c', 'queued'), run('d', 'running'), run('e', 'succeeded')]
    const after = [run('a', 'succeeded'), run('b', 'failed'), run('c', 'cancelled'), run('d', 'running'), run('e', 'succeeded'), run('f', 'succeeded')]
    expect(runsJustFinished(before, after)).toEqual(['a', 'b', 'c'])
  })

  it('does not count runs that were already over, or are new and already over', () => {
    expect(runsJustFinished([], [run('old', 'succeeded')])).toEqual([])
    expect(runsJustFinished([run('old', 'succeeded')], [run('old', 'succeeded')])).toEqual([])
  })
})

describe('useLoomMarkState', () => {
  afterEach(() => { vi.useRealTimers() })

  it('blinks once when a run it saw live finishes, then rests', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ records, waiting, working }) => useLoomMarkState(records, waiting, working), {
      initialProps: { records: [] as RunRecord[], waiting: 0, working: 0 },
    })
    expect(result.current).toBe('ready')
    rerender({ records: [run('a', 'running')], waiting: 0, working: 1 })
    expect(result.current).toBe('running')
    rerender({ records: [run('a', 'succeeded')], waiting: 0, working: 0 })
    expect(result.current).toBe('finished')
    act(() => { vi.advanceTimersByTime(FINISHED_FOR_MS) })
    expect(result.current).toBe('ready')
  })

  it('does not blink for runs that were already over when the app opened', () => {
    const { result, rerender } = renderHook(({ records }) => useLoomMarkState(records, 0, 0), { initialProps: { records: [] as RunRecord[] } })
    rerender({ records: [run('yesterday', 'succeeded')] })
    expect(result.current).toBe('ready')
  })

  it('asks rather than blinks when the run that ended now needs you', () => {
    const { result, rerender } = renderHook(({ records, waiting }) => useLoomMarkState(records, waiting, 0), {
      initialProps: { records: [run('a', 'running')], waiting: 0 },
    })
    rerender({ records: [run('a', 'failed')], waiting: 1 })
    expect(result.current).toBe('asking')
  })
})

describe('LoomMark', () => {
  it('draws the pose for its state, and says it only in its tooltip', () => {
    const { container, rerender } = render(<LoomMark size={28} />)
    const svg = () => container.querySelector('svg')!
    expect(svg().dataset).toMatchObject({ state: 'ready', mouth: 'stitch', glow: 'none' })
    expect(svg().hasAttribute('data-glance')).toBe(false)
    expect(svg().getAttribute('aria-hidden')).toBe('true')
    expect(svg().querySelector('title')).toBeNull()

    rerender(<LoomMark size={28} state="running" />)
    expect(svg().dataset).toMatchObject({ state: 'running', glow: 'live', glance: 'true', breathe: 'true' })
    expect(svg().querySelector('title')?.textContent).toBe('A team is working')

    rerender(<LoomMark size={28} state="asking" />)
    expect(svg().dataset).toMatchObject({ mouth: 'o', glow: 'you' })
    expect(svg().querySelector('title')?.textContent).toBe('Something needs you')

    rerender(<LoomMark size={28} state="finished" />)
    expect(svg().dataset).toMatchObject({ blink: 'true', glow: 'none' })
  })

  it('stays still under reduced motion', () => {
    const matchMedia = vi.fn((query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    vi.stubGlobal('matchMedia', matchMedia)
    try {
      const { container } = render(<LoomMark size={28} state="running" />)
      const svg = container.querySelector('svg')!
      expect(svg.hasAttribute('data-glance')).toBe(false)
      expect(svg.hasAttribute('data-breathe')).toBe(false)
      expect(svg.dataset.glow).toBe('live')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
