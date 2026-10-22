import { describe, expect, it } from 'vitest'

import { advance, arrive, NOTHING_OUT, tuckNow, tuckOnClick, wakesAt, type Circumstances, type PopState } from './popouts'
import type { Pop } from './teams'
import { ISLAND_WAITS } from './waits'

const calm: Circumstances = { now: 0, away: false, fullScreen: false, teamsAtWork: 1, notch: true, pointer: false }
const start: Pop = { kind: 'start', runId: 'a', key: 'researcher' }
const handover: Pop = { kind: 'handover', runId: 'a', key: 'writer' }
const ask: Pop = { kind: 'ask', runId: 'a', key: 'a:permission:p1' }
const otherAsk: Pop = { kind: 'ask', runId: 'b', key: 'b:permission:p2' }
const done: Pop = { kind: 'done', runId: 'a', key: 'a' }
const always = () => true

function bring(state: PopState, c: Partial<Circumstances> = {}, valid = always): PopState {
  return advance(state, { ...calm, ...c }, valid)
}

describe('popping out and tucking away', () => {
  it('a start is out for its wait, then tucks away', () => {
    const out = bring(arrive(NOTHING_OUT, [start], calm))
    expect(out.out?.pop).toEqual(start)
    expect(wakesAt(out)).toBe(ISLAND_WAITS.start)
    expect(bring(out, { now: ISLAND_WAITS.start - 1 }).out?.pop).toEqual(start)
    expect(bring(out, { now: ISLAND_WAITS.start }).out).toBeNull()
  })

  it('a question waits ten seconds, and as long as the pointer is on it', () => {
    const out = bring(arrive(NOTHING_OUT, [ask], calm))
    expect(wakesAt(out)).toBe(ISLAND_WAITS.ask)
    const held = bring(out, { now: 5_000, pointer: true })
    expect(held.out).toMatchObject({ until: null, held: 'pointer' })
    expect(bring(held, { now: 60_000, pointer: true }).out?.pop).toEqual(ask)
    // Let go: a short while longer, then away.
    const letGo = bring(held, { now: 60_000 })
    expect(wakesAt(letGo)).toBe(60_000 + ISLAND_WAITS.afterPointer)
    expect(letGo.out?.held).toBeNull()
    // Let go is let go: a later look at the time does not push the tuck further away.
    expect(wakesAt(bring(letGo, { now: 61_000 }))).toBe(60_000 + ISLAND_WAITS.afterPointer)
    expect(bring(letGo, { now: 60_000 + ISLAND_WAITS.afterPointer }).out).toBeNull()
  })

  it('waits for someone who is away, then gives them the whole wait when they come back', () => {
    const out = bring(arrive(NOTHING_OUT, [ask], { ...calm, away: true }), { away: true })
    expect(out.out).toMatchObject({ until: null, held: 'away' })
    expect(bring(out, { now: 3_600_000, away: true }).out?.pop).toEqual(ask)
    const back = bring(out, { now: 3_600_000 })
    expect(wakesAt(back)).toBe(3_600_000 + ISLAND_WAITS.ask)
  })

  it('with more than one team at work, over a full-screen app, or without a notch, a start or a handover stays tucked', () => {
    for (const c of [{ teamsAtWork: 2 }, { fullScreen: true }, { notch: false }]) {
      expect(bring(arrive(NOTHING_OUT, [start, handover], { ...calm, ...c }), c).out).toBeNull()
    }
    // A question still pops out, and a stop; a result does too, except over a full-screen app.
    expect(bring(arrive(NOTHING_OUT, [ask], { ...calm, fullScreen: true })).out?.pop).toEqual(ask)
    const fail: Pop = { kind: 'fail', runId: 'a', key: 'a' }
    expect(bring(arrive(NOTHING_OUT, [fail], { ...calm, fullScreen: true })).out?.pop).toEqual(fail)
    expect(bring(arrive(NOTHING_OUT, [done], { ...calm, notch: false }), { notch: false }).out?.pop).toEqual(done)
    expect(bring(arrive(NOTHING_OUT, [done], { ...calm, fullScreen: true })).out).toBeNull()
  })

  it('a question takes over from a start at once; questions come one at a time', () => {
    const starting = bring(arrive(NOTHING_OUT, [start], calm))
    const asked = bring(arrive(starting, [ask, otherAsk], calm), { now: 100 })
    expect(asked.out?.pop).toEqual(ask)
    expect(asked.queue).toEqual([otherAsk])
    // The first tucks away; after a breath the next drops.
    const tucked = bring(asked, { now: 100 + ISLAND_WAITS.ask })
    expect(tucked.out).toBeNull()
    expect(bring(tucked, { now: 100 + ISLAND_WAITS.ask + ISLAND_WAITS.between }).out?.pop).toEqual(otherAsk)
  })

  it('a question from another team takes over from a start at once; one from the same team waits its turn', () => {
    const starting = bring(arrive(NOTHING_OUT, [start], calm))
    expect(bring(arrive(starting, [otherAsk], calm), { now: 10 }).out?.pop).toEqual(otherAsk)
    const asking = bring(arrive(NOTHING_OUT, [ask], calm))
    const second: Pop = { kind: 'ask', runId: 'a', key: 'a:permission:p2' }
    const both = bring(arrive(asking, [second], calm), { now: 10 })
    expect(both.out?.pop).toEqual(ask)
    expect(both.queue).toEqual([second])
  })

  it('a handover replaces the start it follows', () => {
    const starting = bring(arrive(NOTHING_OUT, [start], calm))
    expect(bring(arrive(starting, [handover], calm), { now: 10 }).out?.pop).toEqual(handover)
  })

  it('what is no longer so does not stay out: a question answered elsewhere tucks away', () => {
    const out = bring(arrive(NOTHING_OUT, [ask], calm))
    expect(bring(out, { now: 10 }, () => false).out).toBeNull()
    // Nor does one that was waiting its turn come out.
    expect(bring({ ...NOTHING_OUT, queue: [otherAsk] }, {}, () => false).out).toBeNull()
  })

  it('a click elsewhere tucks it away, unless it has only just come out', () => {
    const out = bring(arrive(NOTHING_OUT, [ask], calm))
    expect(tuckOnClick(out, ISLAND_WAITS.clickGrace - 1).out?.pop).toEqual(ask)
    expect(tuckOnClick(out, ISLAND_WAITS.clickGrace).out).toBeNull()
    // The list taking its place, an answer or Open tucks it away at once.
    expect(tuckNow(out, 5).out).toBeNull()
  })
})
