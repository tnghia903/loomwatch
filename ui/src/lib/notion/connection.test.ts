import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { useNotionConnection } from './connection'

afterEach(() => { vi.unstubAllGlobals() })

const connected = () => new Response(JSON.stringify({ connected: true, name: 'Acme', destination: null }), { headers: { 'Content-Type': 'application/json' } })

it('asks the daemon once for every view that reads the connection at the same time', async () => {
  let answer: (response: Response) => void = () => {}
  const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { answer = resolve }))
  vi.stubGlobal('fetch', fetchMock)
  // A chat of answers, each with its Notion line, and the window coming back into focus.
  const { result } = renderHook(() => Array.from({ length: 13 }, () => useNotionConnection()))
  act(() => { window.dispatchEvent(new Event('focus')) })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  await act(async () => { answer(connected()); await Promise.resolve() })
  expect(result.current.every((connection) => connection.state === 'connected')).toBe(true)
  // Asked again once that read is over, it reads again.
  fetchMock.mockImplementation(async () => connected())
  await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve() })
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
