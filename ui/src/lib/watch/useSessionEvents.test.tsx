import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useSessionEvents } from './useSessionEvents'

class MockSocket {
  static all: MockSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  readonly url: URL
  constructor(url: URL) { this.url = url; MockSocket.all.push(this) }
  close() { this.closed = true }
  message(seq: number) { this.onmessage?.({ data: JSON.stringify(event(seq)) }) }
}
const event = (seq: number) => ({ id: `event-${seq}`, seq, sessionId: 's', agentId: 'a', ts: '2026-09-10T00:00:00Z', kind: 'process', payload: { phase: 'spawned' } })
const response = (events: unknown[]) => new Response(JSON.stringify(events), { headers: { 'Content-Type': 'application/json' } })
beforeEach(() => { vi.useFakeTimers(); MockSocket.all = []; vi.stubGlobal('WebSocket', MockSocket) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('recovers after disconnect from the verified cursor without duplicating frames', async () => {
  const fetchMock = vi.fn().mockImplementation(async () => response([event(0)]))
  vi.stubGlobal('fetch', fetchMock)
  const { result, unmount } = renderHook(() => useSessionEvents('s'))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  const first = MockSocket.all[0]
  expect(first.url.searchParams.get('afterSeq')).toBe('0')
  act(() => { first.onopen?.(); first.message(1) })
  await act(async () => { await vi.advanceTimersByTimeAsync(50) })
  expect(result.current.events.map((e) => e.seq)).toEqual([0, 1])
  fetchMock.mockImplementation(async () => response([event(2)]))
  act(() => first.onclose?.())
  expect(result.current.connected).toBe(false)
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('afterSeq=1')
  expect(MockSocket.all[1].url.searchParams.get('afterSeq')).toBe('2')
  expect(result.current.events.map((e) => e.seq)).toEqual([0, 1, 2])
  unmount()
  expect(MockSocket.all[1].closed).toBe(true)
})

it('retains good evidence and recovers a missing WebSocket frame through REST', async () => {
  const fetchMock = vi.fn().mockImplementation(async () => response([event(0)]))
  vi.stubGlobal('fetch', fetchMock)
  const { result, unmount } = renderHook(() => useSessionEvents('s'))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  act(() => MockSocket.all[0].message(2))
  await act(async () => { await vi.advanceTimersByTimeAsync(50) })
  expect(result.current.error).toContain('gap')
  expect(result.current.events).toHaveLength(1)
  fetchMock.mockImplementation(async () => response([event(1), event(2)]))
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(result.current.events).toHaveLength(3)
  expect(result.current.error).toBeNull()
  unmount()
})

it('aborts a pending archive request when changing sessions', async () => {
  let signal: AbortSignal | undefined
  vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, options) => {
    signal = options.signal
    return new Promise(() => {})
  }))
  const { unmount } = renderHook(() => useSessionEvents('s'))
  expect(signal?.aborted).toBe(false)
  unmount()
  expect(signal?.aborted).toBe(true)
})
