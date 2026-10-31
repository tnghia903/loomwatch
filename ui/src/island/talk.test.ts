import { describe, expect, it, vi } from 'vitest'

import { loudness, talkProblem, withHeard } from './talk'

describe('talking to the box’s agent', () => {
  it('puts what is heard after what was written, one space between', () => {
    expect(withHeard('', 'Book a table')).toBe('Book a table')
    expect(withHeard('Book the ', ' train to Kyoto ')).toBe('Book the train to Kyoto')
    expect(withHeard('Book the', 'train')).toBe('Book the train')
    // Nothing heard yet leaves what was written as it was.
    expect(withHeard('Book the ', '  ')).toBe('Book the ')
  })

  it('says why it could not listen, with System Settings only where a switch there puts it right', () => {
    expect(talkProblem('microphone').pane).toBe('microphone')
    expect(talkProblem('speech').pane).toBe('speech')
    expect(talkProblem('asked')).toEqual({ text: 'Allow LoomWatch when macOS asks, then hold ⌃⌥Space again.', failed: false, pane: null })
    // Marked as failed only where something is wrong, not where it only needs another try.
    expect((['microphone', 'speech', 'unavailable', 'noMicrophone', 'asked', 'longest', 'nothing'] as const).map((why) => talkProblem(why).failed)).toEqual([true, true, true, true, false, false, false])
    for (const why of ['unavailable', 'noMicrophone', 'longest', 'nothing'] as const) expect(talkProblem(why).pane).toBeNull()
    expect(talkProblem('unavailable').pane).toBeNull()
  })

  it('tells only those that listen, and only when the loudness changes, between 0 and 1', () => {
    const level = loudness()
    const told = vi.fn()
    const stop = level.subscribe(told)
    level.set(0.4)
    level.set(0.4)
    expect(told).toHaveBeenCalledTimes(1)
    expect(level.get()).toBe(0.4)
    level.set(3)
    expect(level.get()).toBe(1)
    level.set(Number.NaN)
    expect(level.get()).toBe(0)
    stop()
    level.set(0.7)
    expect(told).toHaveBeenCalledTimes(3)
  })
})
