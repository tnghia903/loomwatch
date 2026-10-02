import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useNow } from './useNow'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-02T10:00:00Z'))
})
afterEach(() => vi.useRealTimers())

describe('useNow', () => {
  it('counts every second while running, and holds still once it stops', () => {
    const { result, rerender } = renderHook(({ running }) => useNow(running), { initialProps: { running: true } })
    const start = Date.parse('2026-10-02T10:00:00Z')
    expect(result.current).toBe(start)

    act(() => { vi.advanceTimersByTime(3000) })
    expect(result.current).toBe(start + 3000)

    rerender({ running: false })
    act(() => { vi.advanceTimersByTime(5000) })
    expect(result.current).toBe(start + 3000)
    expect(vi.getTimerCount()).toBe(0)
  })
})
