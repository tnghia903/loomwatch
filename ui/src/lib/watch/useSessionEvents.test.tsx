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
  await act(async () => { await Promise.resolve() })
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

it('reads the whole archive before showing it, so a long run opens as it ended', async () => {
  const pages = [Array.from({ length: 500 }, (_, seq) => event(seq)), [event(500), event(501)]]
  const fetchMock = vi.fn().mockImplementation(async () => response(pages.shift() ?? []))
  vi.stubGlobal('fetch', fetchMock)
  const seen: number[] = []
  const { result, unmount } = renderHook(() => { const state = useSessionEvents('s'); seen.push(state.events.length); return state })
  expect(result.current.loading).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(String(fetchMock.mock.calls[1]?.[0])).toContain('afterSeq=499')
  expect(seen).not.toContain(500)
  expect(result.current.events).toHaveLength(502)
  expect(result.current.loading).toBe(false)
  expect(MockSocket.all[0].url.searchParams.get('afterSeq')).toBe('501')
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
  await act(async () => { await Promise.resolve() })
  expect(signal?.aborted).toBe(true)
})

it('asks the archive and the stream for lean events', async () => {
  const fetchMock = vi.fn().mockImplementation(async () => response([event(0)]))
  vi.stubGlobal('fetch', fetchMock)
  const { unmount } = renderHook(() => useSessionEvents('s'))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(new URL(String(fetchMock.mock.calls[0]?.[0]), 'http://x').searchParams.get('lean')).toBe('true')
  expect(MockSocket.all[0].url.searchParams.get('lean')).toBe('true')
  unmount()
})

it('shares one read and one socket between views of the same session', async () => {
  const fetchMock = vi.fn().mockImplementation(async () => response([event(0)]))
  vi.stubGlobal('fetch', fetchMock)
  const { result, unmount } = renderHook(() => [useSessionEvents('s'), useSessionEvents('s')])
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(MockSocket.all).toHaveLength(1)
  act(() => { MockSocket.all[0].onopen?.(); MockSocket.all[0].message(1) })
  await act(async () => { await vi.advanceTimersByTimeAsync(50) })
  expect(result.current[0].events.map((e) => e.seq)).toEqual([0, 1])
  expect(result.current[1].events).toBe(result.current[0].events)
  unmount()
  await act(async () => { await Promise.resolve() })
  expect(MockSocket.all[0].closed).toBe(true)
})

it('keeps the session while a view of it moves, and reads it again once nothing shows it', async () => {
  const fetchMock = vi.fn().mockImplementation(async () => response([event(0)]))
  vi.stubGlobal('fetch', fetchMock)
  const { rerender, unmount } = renderHook(({ which }) => (which === 'a' ? useSessionEvents('s') : [useSessionEvents('s')]), { initialProps: { which: 'a' } })
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  rerender({ which: 'b' })
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  unmount()
  await act(async () => { await Promise.resolve() })
  const again = renderHook(() => useSessionEvents('s'))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(fetchMock).toHaveBeenCalledTimes(2)
  again.unmount()
})

it('opens no socket for a session already whole in the archive, and follows only to its last event', async () => {
  const fetchMock = vi.fn().mockImplementation(async () => response([event(0), event(1)]))
  vi.stubGlobal('fetch', fetchMock)
  const whole = renderHook(() => useSessionEvents('s', 2))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(whole.result.current.events).toHaveLength(2)
  expect(whole.result.current.loading).toBe(false)
  expect(MockSocket.all).toHaveLength(0)
  whole.unmount()
  await act(async () => { await Promise.resolve() })

  // A run that finished while it was watched: the socket stays until its last event arrives.
  const { result, rerender, unmount } = renderHook(({ until }) => useSessionEvents('s', until), { initialProps: { until: null as number | null } })
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  const socket = MockSocket.all[0]
  act(() => socket.onopen?.())
  rerender({ until: 3 })
  expect(socket.closed).toBe(false)
  act(() => socket.message(2))
  await act(async () => { await vi.advanceTimersByTimeAsync(50) })
  expect(result.current.events).toHaveLength(3)
  expect(socket.closed).toBe(true)
  expect(result.current.connected).toBe(false)
  expect(result.current.error).toBeNull()
  // Nothing retries a socket closed on purpose.
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(MockSocket.all).toHaveLength(1)
  unmount()
})
