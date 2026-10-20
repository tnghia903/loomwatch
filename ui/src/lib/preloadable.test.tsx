import { act, cleanup, render, screen } from '@testing-library/react'
import { Suspense } from 'react'
import { afterEach, expect, it } from 'vitest'

import { preloadable } from './preloadable'

afterEach(cleanup)

function Words({ text }: { text: string }) { return <p>{text}</p> }

// A part of the page whose code comes as its own download (preloadable.ts). Once fetched ahead it
// shows at once: no "Loading…" first, which React would keep up for 300 ms.
it('shows at once when its code was fetched ahead', async () => {
  const Part = preloadable(async () => Words)
  await Part.preload()
  render(<Suspense fallback={<p>Loading…</p>}><Part text="The answer" /></Suspense>)
  expect(screen.getByText('The answer')).toBeTruthy()
  expect(screen.queryByText('Loading…')).toBeNull()
})

it('loads on first use when nothing fetched it ahead, once', async () => {
  let loads = 0
  const Part = preloadable(async () => { loads += 1; return Words })
  render(<Suspense fallback={<p>Loading…</p>}><Part text="The answer" /><Part text="Another" /></Suspense>)
  expect(screen.getByText('Loading…')).toBeTruthy()
  expect(await screen.findByText('The answer')).toBeTruthy()
  expect(screen.getByText('Another')).toBeTruthy()
  expect(loads).toBe(1)
})

it('asks again after a download fails', async () => {
  let tries = 0
  const Part = preloadable(async () => { tries += 1; if (tries === 1) throw new Error('offline'); return Words })
  await expect(Part.preload()).rejects.toThrow('offline')
  await act(async () => { await Part.preload() })
  render(<Suspense fallback={<p>Loading…</p>}><Part text="The answer" /></Suspense>)
  expect(screen.getByText('The answer')).toBeTruthy()
  expect(tries).toBe(2)
})
