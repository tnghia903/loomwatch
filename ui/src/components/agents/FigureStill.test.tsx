import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { figureStill, garmentMask, signStill, signTint } from '../../lib/library/figures'
import { FigureStill } from './FigureStill'

afterEach(cleanup)

describe('a figure’s still', () => {
  it('wears its job’s sign on its head, the grey picture tinted to the figure’s own colour', () => {
    const { container } = render(<FigureStill figure={{ kind: 'tall', color: 'lilac', sign: 'research' }} alt="" width={40} height={40} />)
    const box = container.querySelector('.figure-still') as HTMLElement
    expect(box.querySelector('img')).toHaveAttribute('src', figureStill({ kind: 'tall', color: 'lilac' }))
    const sign = box.querySelector('.figure-sign') as HTMLElement
    expect(sign.style.getPropertyValue('--sign')).toBe(`url("${signStill('tall', 'research')}")`)
    expect(sign.style.getPropertyValue('--tint')).toBe(signTint('lilac'))
    expect(sign).toHaveAttribute('aria-hidden', 'true')
  })

  it('tints one sign picture to each colour, so the same job reads the same on every figure', () => {
    const { container } = render(<>
      <FigureStill figure={{ kind: 'egg', color: 'sage', sign: 'code' }} alt="" />
      <FigureStill figure={{ kind: 'egg', color: 'plum', sign: 'code' }} alt="" />
    </>)
    const [sage, plum] = [...container.querySelectorAll('.figure-sign')] as HTMLElement[]
    expect(sage.style.getPropertyValue('--sign')).toBe(plum.style.getPropertyValue('--sign'))
    expect(sage.style.getPropertyValue('--tint')).not.toBe(plum.style.getPropertyValue('--tint'))
  })

  it('in clothes, draws the bare figure through the garment’s mask, so its fur doesn’t stand round them', () => {
    const { container } = render(<FigureStill figure={{ kind: 'egg', color: 'rose', wear: ['black_dress', 'beret'] }} state="waiting" alt="" />)
    const still = container.querySelector('.figure-still > img') as HTMLElement
    expect(still.style.maskImage).toBe(`url("${garmentMask('egg', 'black_dress', 'waiting')}")`)
    expect(garmentMask('egg', 'black_dress', 'waiting')).toBe('/agent/masks/egg-black_dress-waiting.webp')
  })

  it('as a head-only face, which draws no clothes, draws the figure whole', () => {
    const { container } = render(<FigureStill figure={{ kind: 'egg', color: 'rose', wear: ['black_dress', 'beret'] }} headOnly alt="" />)
    expect((container.querySelector('.figure-still > img') as HTMLElement).style.maskImage).toBe('')
  })

  it('without clothes draws the bare figure whole, even with other pieces on', () => {
    const { container } = render(<FigureStill figure={{ kind: 'egg', color: 'rose', wear: ['beret', 'bow'] }} alt="" />)
    expect((container.querySelector('.figure-still > img') as HTMLElement).style.maskImage).toBe('')
  })

  it('without a sign or anything worn is the plain picture', () => {
    const { container } = render(<FigureStill figure={{ kind: 'wide', color: 'rose' }} alt="" />)
    expect(container.firstElementChild?.tagName).toBe('IMG')
    expect(container.querySelector('.figure-sign')).toBeNull()
  })
})

describe('a figure’s still in its state (step 5)', () => {
  const figure = { kind: 'tall' as const, color: 'lilac' as const, sign: 'research' as const, wear: ['beret' as const, 'striped_top' as const] }

  it('draws its state’s pose: the still, the sign and every piece it wears, as the head and paws move', () => {
    const { container } = render(<FigureStill figure={figure} state="working" alt="" width={40} height={40} />)
    const box = container.querySelector('.figure-still') as HTMLElement
    expect(box).toHaveAttribute('data-pose', 'working')
    expect(box.querySelector('img')).toHaveAttribute('src', '/agent/figures/tall-lilac-working.webp')
    expect((box.querySelector('.figure-sign') as HTMLElement).style.getPropertyValue('--sign')).toBe('url("/agent/signs/tall-research-working.webp")')
    expect([...box.querySelectorAll('.worn-overlay img')].map((img) => img.getAttribute('src'))).toEqual(['/agent/wear/tall-striped_top-working.webp', '/agent/wear/tall-beret-working.webp'])
  })

  it('is ready’s plain pictures when no state is given', () => {
    const { container } = render(<FigureStill figure={{ kind: 'egg', color: 'rose' }} alt="" />)
    expect(container.querySelector('img')).toHaveAttribute('src', '/agent/figures/egg-rose.webp')
    expect(container.querySelector('img')).toHaveAttribute('data-pose', 'ready')
  })

  it('settles into a new pose once when its state changes, never on its first draw', () => {
    const { container, rerender } = render(<FigureStill figure={figure} state="ready" alt="" />)
    expect(container.querySelector('[data-pose]')).not.toHaveAttribute('data-moved')
    rerender(<FigureStill figure={figure} state="waiting" alt="" />)
    const moved = container.querySelector('[data-pose]') as HTMLElement
    expect(moved).toHaveAttribute('data-pose', 'waiting')
    expect(moved).toHaveAttribute('data-moved')
    // Drawn anew for the change, so its settle plays (a kept element would not restart it).
    rerender(<FigureStill figure={figure} state="done" alt="" />)
    expect(container.querySelector('[data-pose]')).not.toBe(moved)
    expect(container.querySelector('[data-pose]')).toHaveAttribute('data-pose', 'done')
  })
})
