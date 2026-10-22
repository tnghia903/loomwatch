import { describe, expect, it } from 'vitest'

import type { RunRecord } from '../lib/runs/client'
import { at, iso, permission, run } from './fixtures'
import { initialIsland, islandReducer, viewOf, type IslandAction, type IslandState } from './state'
import { ISLAND_WAITS } from './waits'

function play(steps: [number, IslandAction][], start = initialIsland(at(0), true)): IslandState {
  return steps.reduce((state, [now, action]) => islandReducer(state, { ...action, now }), start)
}

const placed: IslandAction = { type: 'app', message: { kind: 'place', notch: { width: 188, height: 32 }, menuBar: 32 } }
const runs = (...records: RunRecord[]): IslandAction => ({ type: 'runs', records })

describe('the island, moment by moment', () => {
  it('stays hidden until the app says where it is, then rests as the notch', () => {
    expect(viewOf(initialIsland(at(0), true))).toBe('hidden')
    expect(viewOf(play([[at(0), placed], [at(0), runs()]]))).toBe('rest')
  })

  it('pops a start out below the notch, then tucks it into the menu bar', () => {
    const s = play([[at(0), placed], [at(0), runs()], [at(1), runs(run('a', { working: ['researcher'] }))]])
    expect(viewOf(s)).toBe('work')
    expect(viewOf(islandReducer(s, { type: 'tick', now: at(1) + ISLAND_WAITS.start }))).toBe('tucked')
  })

  it('drops a question; answering it drops the next at once', () => {
    const asking = run('a', { permissionRequests: [permission('p1'), permission('p2')] })
    let s = play([[at(0), placed], [at(0), runs()], [at(1), runs(asking)]])
    expect([viewOf(s), s.pop.out?.pop.key]).toEqual(['ask', 'a:permission:p1'])
    s = islandReducer(s, { type: 'answered', ticket: 'a:permission:p1', now: at(1) + 2000 })
    s = islandReducer(s, { type: 'runs', records: [run('a', { permissionRequests: [permission('p2')] })], now: at(1) + 2100 })
    expect([viewOf(s), s.pop.out?.pop.key]).toEqual(['ask', 'a:permission:p2'])
  })

  it('answering one question drops the next at once, even one that already had its turn', () => {
    const asking = run('a', { permissionRequests: [permission('p1'), permission('p2')] })
    let s = play([[at(0), placed], [at(0), runs()], [at(1), runs(asking)]])
    // Both have had their turn and tucked away.
    s = islandReducer(s, { type: 'tick', now: at(1) + ISLAND_WAITS.ask })
    s = islandReducer(s, { type: 'tick', now: at(1) + ISLAND_WAITS.ask + ISLAND_WAITS.between })
    s = islandReducer(s, { type: 'tick', now: at(1) + 2 * ISLAND_WAITS.ask + ISLAND_WAITS.between })
    expect(viewOf(s)).toBe('tucked')
    s = islandReducer(s, { type: 'answered', ticket: 'a:permission:p1', now: at(3) })
    expect([viewOf(s), s.pop.out?.pop.key]).toEqual(['ask', 'a:permission:p2'])
  })

  it('pointing at the island opens the list in place of what was out; it closes once the pointer has left', () => {
    let s = play([[at(0), placed], [at(0), runs()], [at(1), runs(run('a', { permissionRequests: [permission('p1')] }))]])
    s = islandReducer(s, { type: 'pointerOnIsland', over: true, now: at(1) + 500 })
    expect(viewOf(s)).toBe('list')
    expect(s.pop.out).toBeNull()
    // Still on it: the list stays.
    expect(viewOf(islandReducer(s, { type: 'closeList', now: at(2) }))).toBe('list')
    s = islandReducer(s, { type: 'pointerOnIsland', over: false, now: at(2) })
    expect(viewOf(islandReducer(s, { type: 'closeList', now: at(2) }))).toBe('tucked')
  })

  it('a result stays beside the notch until you look at the list, then leaves', () => {
    let s = play([
      [at(0), placed],
      [at(0), runs(run('a', { working: ['writer'] }))],
      [at(5), runs(run('a', { status: 'succeeded', finishedAt: iso(5), reply: 'Five days in Kyoto' }))],
    ])
    expect(viewOf(s)).toBe('done')
    s = islandReducer(s, { type: 'tick', now: at(5) + ISLAND_WAITS.result })
    expect(viewOf(s)).toBe('tucked')
    s = islandReducer(s, { type: 'pointerOnIsland', over: true, now: at(6) })
    s = islandReducer(s, { type: 'pointerOnIsland', over: false, now: at(6) + 100 })
    s = islandReducer(s, { type: 'closeList', now: at(6) + 900 })
    expect(viewOf(s)).toBe('rest')
    // Reading the runs again does not bring it back.
    s = islandReducer(s, { type: 'runs', records: [run('a', { status: 'succeeded', finishedAt: iso(5) })], now: at(7) })
    expect(viewOf(s)).toBe('rest')
  })

  it('hears from the app where the pointer is: the island opens the list, a question stays out while it is on it', () => {
    const asking = run('a', { permissionRequests: [permission('p1')] })
    let s = play([[at(0), placed], [at(0), runs()], [at(1), runs(asking)]])
    // On the question's card (the second area): it stays out past its ten seconds.
    s = islandReducer(s, { type: 'app', message: { kind: 'pointer', over: true, area: 1 }, now: at(1) + 1000 })
    s = islandReducer(s, { type: 'tick', now: at(1) + ISLAND_WAITS.ask * 3 })
    expect(viewOf(s)).toBe('ask')
    // Off everything: a moment more, then it tucks away.
    s = islandReducer(s, { type: 'app', message: { kind: 'pointer', over: false, area: null }, now: at(2) })
    expect(viewOf(islandReducer(s, { type: 'tick', now: at(2) + ISLAND_WAITS.afterPointer }))).toBe('tucked')
    // On the island itself (the first area): the list.
    s = islandReducer(s, { type: 'app', message: { kind: 'pointer', over: true, area: 0 }, now: at(3) })
    expect(viewOf(s)).toBe('list')
    // Off it, as the app says: the list closes.
    s = islandReducer(s, { type: 'app', message: { kind: 'pointer', over: false, area: null }, now: at(3) + 100 })
    expect(viewOf(islandReducer(s, { type: 'closeList', now: at(3) + 800 }))).toBe('tucked')
  })

  it('the list takes the place of a question that is out', () => {
    let s = play([[at(0), placed], [at(0), runs()], [at(1), runs(run('a', { permissionRequests: [permission('p1')] }))]])
    s = islandReducer(s, { type: 'app', message: { kind: 'pointer', over: true, area: 0 }, now: at(1) + 500 })
    expect(viewOf(s)).toBe('list')
    expect(s.pop.out).toBeNull()
  })

  it('a click elsewhere tucks away what is out, once it has been out a moment', () => {
    let s = play([[at(0), placed], [at(0), runs()], [at(1), runs(run('a', { permissionRequests: [permission('p1')] }))]])
    s = islandReducer(s, { type: 'app', message: { kind: 'clickOutside' }, now: at(1) + 300 })
    expect(viewOf(s)).toBe('ask')
    s = islandReducer(s, { type: 'app', message: { kind: 'clickOutside' }, now: at(1) + ISLAND_WAITS.clickGrace })
    expect(viewOf(s)).toBe('tucked')
  })

  it('without a notch, it shows only while a question or a result has dropped', () => {
    const noNotch: IslandAction = { type: 'app', message: { kind: 'place', notch: null, menuBar: 24 } }
    expect(viewOf(play([[at(0), noNotch], [at(0), runs()]]))).toBe('hidden')
    let s = play([[at(0), noNotch], [at(0), runs()], [at(1), runs(run('a', { working: ['researcher'] }))]])
    expect(viewOf(s)).toBe('hidden')
    s = islandReducer(s, { type: 'runs', records: [run('a', { permissionRequests: [permission('p1')] })], now: at(2) })
    expect(viewOf(s)).toBe('ask')
    s = islandReducer(s, { type: 'tick', now: at(2) + ISLAND_WAITS.ask })
    expect(viewOf(s)).toBe('hidden')
  })
})
