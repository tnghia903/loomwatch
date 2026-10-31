import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { holdPage } from './inPlace'
import { useLeaveTeam } from './leaveTeam'
import type { SaveState } from './useTeamDocument'

const goToTeam = vi.hoisted(() => vi.fn())
vi.mock('./teamPage', () => ({ goToTeam }))

let release: (() => void) | null = null
beforeEach(() => { goToTeam.mockReset() })
afterEach(() => { release?.(); release = null })

function leaving(state: SaveState, save = vi.fn(async () => true), reload = vi.fn(async () => {})) {
  const hook = renderHook(({ now }: { now: SaveState }) => useLeaveTeam(now, save, reload), { initialProps: { now: state } })
  return { ...hook, save, reload }
}

it('asks first only while leaving would lose changes the person made', () => {
  const { result, rerender } = leaving('dirty')
  expect(result.current.asks()).toBe(false)
  release = holdPage()
  expect(result.current.asks()).toBe(true)
  rerender({ now: 'conflict' })
  expect(result.current.asks()).toBe(true)
  // A team not saved yet, or one saving now, goes as a page load the browser asks about.
  rerender({ now: 'new' })
  expect(result.current.asks()).toBe(false)
  rerender({ now: 'saving' })
  expect(result.current.asks()).toBe(false)
})

// The move waits until the saved team is on screen, so the page is no longer held and moves in place.
it('goes once the save has landed, not while it is saving', async () => {
  const { result, rerender, save } = leaving('dirty')
  await act(async () => { await result.current.saveThenGo('/?path=b.yaml&view=chat') })
  expect(save).toHaveBeenCalledTimes(1)
  expect(goToTeam).not.toHaveBeenCalled()
  rerender({ now: 'saving' })
  expect(goToTeam).not.toHaveBeenCalled()
  rerender({ now: 'saved' })
  expect(goToTeam).toHaveBeenCalledWith('/?path=b.yaml&view=chat')
  rerender({ now: 'dirty' })
  rerender({ now: 'saved' })
  expect(goToTeam).toHaveBeenCalledTimes(1)
})

it('stays when the save fails, and does not go on a later save', async () => {
  const { result, rerender } = leaving('dirty', vi.fn(async () => false))
  let saved = true
  await act(async () => { saved = await result.current.saveThenGo('/?path=b.yaml') })
  expect(saved).toBe(false)
  rerender({ now: 'error' })
  rerender({ now: 'saved' })
  expect(goToTeam).not.toHaveBeenCalled()
})

// A save refused before it starts (one already under way, the schema still loading) changes nothing.
it('forgets the move when the save is refused before it starts', async () => {
  const { result, rerender } = leaving('dirty', vi.fn(async () => false))
  await act(async () => { await result.current.saveThenGo('/?path=b.yaml') })
  // The person saves later, from the chip, and stays on the team.
  rerender({ now: 'saving' })
  rerender({ now: 'saved' })
  expect(goToTeam).not.toHaveBeenCalled()
})

it('stays when the save is refused on the way, as a team changed outside LoomWatch is', async () => {
  const { result, rerender } = leaving('dirty')
  await act(async () => { await result.current.saveThenGo('/?path=b.yaml') })
  rerender({ now: 'saving' })
  rerender({ now: 'conflict' })
  rerender({ now: 'saved' })
  expect(goToTeam).not.toHaveBeenCalled()
})

it('drops the changes by reading the team again, then goes', async () => {
  const { result, rerender, reload } = leaving('dirty')
  await act(async () => { await result.current.dropThenGo('/?path=b.yaml') })
  expect(reload).toHaveBeenCalledTimes(1)
  expect(goToTeam).not.toHaveBeenCalled()
  rerender({ now: 'clean' })
  expect(goToTeam).toHaveBeenCalledWith('/?path=b.yaml')
})

it('goes at once with nothing unsaved', () => {
  const { result } = leaving('clean')
  result.current.go('/?path=b.yaml&view=chat')
  expect(goToTeam).toHaveBeenCalledWith('/?path=b.yaml&view=chat')
})
