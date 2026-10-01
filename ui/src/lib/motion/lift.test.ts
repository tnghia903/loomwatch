import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { liftInto, markLiftOrigin, noteShownRequest } from './lift'

describe('lifting a sent request into the run it started', () => {
  const animate = vi.fn(() => ({ finished: Promise.resolve() }) as unknown as Animation)
  const composer = () => document.body.appendChild(document.createElement('textarea'))
  const requestBox = (text: string) => {
    const box = document.body.appendChild(document.createElement('p'))
    box.textContent = text
    return box
  }

  beforeEach(() => {
    // jsdom has no Web Animations; the lift only needs `animate` to exist and be called.
    HTMLElement.prototype.animate = animate
    noteShownRequest('')
    markLiftOrigin(null, '')
  })
  afterEach(() => {
    delete (HTMLElement.prototype as Partial<HTMLElement>).animate
    animate.mockClear()
    document.body.replaceChildren()
  })

  it('flies a follow-up from the composer into the Request box that now shows it', () => {
    noteShownRequest('Research the market')
    markLiftOrigin(composer(), 'Make it shorter')
    expect(liftInto(requestBox('Make it shorter'), 'Make it shorter')).toBe(true)
    expect(document.querySelector('.lift-ghost')?.textContent).toBe('Make it shorter')
  })

  // The planned Request box mirrors the composer as the operator types, so on ↵ the text is
  // already where it would land. Lifting it would make it vanish and come back.
  it('leaves a first run alone, whose Request box already showed the text', () => {
    noteShownRequest('Research the market')
    markLiftOrigin(composer(), 'Research the market')
    expect(liftInto(requestBox('Research the market'), 'Research the market')).toBe(false)
    expect(animate).not.toHaveBeenCalled()
  })

  it('lifts once, and never into a run that shows some other request', () => {
    markLiftOrigin(composer(), 'Make it shorter')
    expect(liftInto(requestBox('Summarise last week'), 'Summarise last week')).toBe(false)
    expect(liftInto(requestBox('Make it shorter'), 'Make it shorter')).toBe(true)
    expect(liftInto(requestBox('Make it shorter'), 'Make it shorter')).toBe(false)
  })

  it('gives up on a send whose run never appeared', () => {
    vi.useFakeTimers()
    try {
      markLiftOrigin(composer(), 'Make it shorter')
      vi.advanceTimersByTime(16_000)
      expect(liftInto(requestBox('Make it shorter'), 'Make it shorter')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
