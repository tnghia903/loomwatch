import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { SegmentThumb } from './SegmentThumb'

// jsdom has no layout, so each segment reports the geometry a browser would measure, from data-*.
const GEOMETRY = { offsetLeft: 'left', offsetTop: 'top', offsetWidth: 'width', offsetHeight: 'height' } as const
const saved = new Map<string, PropertyDescriptor | undefined>()
beforeAll(() => {
  for (const [prop, key] of Object.entries(GEOMETRY)) {
    saved.set(prop, Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop))
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get(this: HTMLElement) { return Number(this.dataset[key] ?? 0) } })
  }
})
afterAll(() => {
  for (const [prop, descriptor] of saved) if (descriptor) Object.defineProperty(HTMLElement.prototype, prop, descriptor)
})

function Switch() {
  const [view, setView] = useState<'run' | 'build'>('build')
  return (
    <nav aria-label="Workspace view">
      <SegmentThumb />
      <button data-left={3} data-top={3} data-width={83} data-height={34} aria-pressed={view === 'run'} onClick={() => setView('run')}>Run</button>
      <button data-left={89} data-top={3} data-width={89} data-height={34} aria-pressed={view === 'build'} onClick={() => setView('build')}>Build</button>
    </nav>
  )
}

afterEach(cleanup)

describe('SegmentThumb', () => {
  const thumb = () => document.querySelector<HTMLElement>('.segment-thumb')!

  it('starts under the selected segment, at its measured size', () => {
    render(<Switch />)
    expect(thumb().style.translate).toBe('89px 3px')
    expect(thumb().style.width).toBe('89px')
    expect(thumb().style.height).toBe('34px')
    expect(thumb()).toHaveAttribute('aria-hidden', 'true')
  })

  it('follows the selection to the other segment', async () => {
    render(<Switch />)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    // The thumb learns of the change from the attribute itself, a microtask after React commits.
    await Promise.resolve()
    expect(thumb().style.translate).toBe('3px 3px')
    expect(thumb().style.width).toBe('83px')
  })
})
