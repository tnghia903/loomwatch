// TNG-158 / TNG89 §6.3: the live region must announce every queued message in order.
// The defect was a candidate list resolved with `.find(Boolean)` — one message per
// render, the rest discarded — so these tests pin the FIFO drain, the repeat marker and
// the empty-message guard.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAnnouncementQueue } from './useAnnouncementQueue'

const HOLD = 1000

describe('useAnnouncementQueue', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('announces every queued message in order, not just the first', () => {
    const { result } = renderHook(() => useAnnouncementQueue(HOLD))
    act(() => {
      result.current[1]('Team saved.')
      result.current[1]('Could not save team.')
      result.current[1]('The team file changed on disk.')
    })
    expect(result.current[0]).toBe('Team saved.')
    act(() => vi.advanceTimersByTime(HOLD))
    expect(result.current[0]).toBe('Could not save team.')
    act(() => vi.advanceTimersByTime(HOLD))
    expect(result.current[0]).toBe('The team file changed on disk.')
    // The queue is drained; the last message stays until the next one arrives.
    act(() => vi.advanceTimersByTime(HOLD))
    expect(result.current[0]).toBe('The team file changed on disk.')
  })

  it('marks a repeated message so the region change is real', () => {
    const { result } = renderHook(() => useAnnouncementQueue(HOLD))
    act(() => result.current[1]('Team saved.'))
    act(() => result.current[1]('Team saved.'))
    act(() => vi.advanceTimersByTime(HOLD))
    expect(result.current[0]).toBe('Team saved.\u200b')
  })

  it('never queues an empty message', () => {
    const { result } = renderHook(() => useAnnouncementQueue(HOLD))
    act(() => {
      result.current[1]('')
      result.current[1](null)
      result.current[1](undefined)
    })
    expect(result.current[0]).toBe('')
  })
})