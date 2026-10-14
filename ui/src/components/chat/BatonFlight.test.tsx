import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Flight } from '../../lib/chat/pieceLine'
import { BatonFlight } from './BatonFlight'

let flown: Keyframe[][] = []
beforeEach(() => {
  flown = []
  Element.prototype.animate = function animate(keyframes: Keyframe[] | PropertyIndexedKeyframes | null) {
    flown.push(keyframes as Keyframe[])
    return { onfinish: null, cancel: vi.fn() } as unknown as Animation
  }
})
afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  delete (Element.prototype as Partial<Element>).animate
})

const up: Flight = { id: 1, way: 'up', from: { left: 40, top: 300, width: 220, height: 20 }, to: null, agent: 'researcher', words: 'Researcher is working…', hue: 1, waiting: false }

describe('the line on its way to the pill', () => {
  // 2026-10-15, live: a handover pushed the line out of view in the same moment the work moved from
  // Researcher to Writer. The flight set off for Researcher's pill, which was gone, and never flew.
  it('lands on the pill the header shows now, saying what it says now', () => {
    const header = document.createElement('span')
    header.innerHTML = '<span class="tc-baton on" data-baton-target="writer"><span class="tc-baton-in">Passing to Writer…</span></span>'
    document.body.append(header)
    const onDone = vi.fn()
    render(<BatonFlight flight={up} holding={{ agent: 'writer', words: 'Passing to Writer…', hue: 2, waiting: false }} onDone={onDone} />)
    expect(flown).toHaveLength(1)
    expect(onDone).not.toHaveBeenCalled()
    const ghost = document.querySelector('.tc-baton-ghost')
    expect(ghost).toHaveTextContent('Passing to Writer…')
    expect(ghost).toHaveClass('hue-2')
  })

  it('says what it set off saying once nobody has the work, and gives up at once with nowhere to land', () => {
    const onDone = vi.fn()
    render(<BatonFlight flight={up} holding={null} onDone={onDone} />)
    expect(document.querySelector('.tc-baton-ghost')).toHaveTextContent('Researcher is working…')
    expect(onDone).toHaveBeenCalledWith(1)
    expect(flown).toHaveLength(0)
  })
})
