import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { useNotionConnection } from './connection'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const answer = (connected: boolean) => new Response(JSON.stringify(connected ? { connected: true, name: 'Notion', destination: null, problem: null } : { connected: false }), { headers: { 'Content-Type': 'application/json' } })

it('asks the daemon once for every view that reads the connection at the same time', async () => {
  const fetchMock = vi.fn().mockImplementation(async () => answer(true))
  vi.stubGlobal('fetch', fetchMock)
  // A chat of answers, each with its Notion line.
  const { result } = renderHook(() => Array.from({ length: 13 }, () => useNotionConnection()))
  await act(async () => { await Promise.resolve() })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(result.current.every((connection) => connection.state === 'connected')).toBe(true)
  // The window coming back into focus: every view asks again, and they share one read.
  await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve() })
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('never answers a refresh with a read that started before it', async () => {
  let first: (response: Response) => void = () => {}
  const fetchMock = vi.fn()
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { first = resolve }))
    .mockImplementation(async () => answer(true))
  vi.stubGlobal('fetch', fetchMock)
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
  // The first read waits (on macOS asking about the Keychain); meanwhile you connect and come back.
  const { result } = renderHook(() => useNotionConnection())
  now.mockReturnValue(2_000)
  await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve() })
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(result.current.state).toBe('connected')
  // The old read ending late does not put its answer back.
  await act(async () => { first(answer(false)); await Promise.resolve() })
  expect(result.current.state).toBe('connected')
})
