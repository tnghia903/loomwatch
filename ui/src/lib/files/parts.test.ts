import { afterEach, describe, expect, it, vi } from 'vitest'

import { boxBetween, boxLabel, boxOnScreen, boxStyle, partPictureName, pictureInside, wholeBox, WHOLE } from './parts'

afterEach(() => vi.restoreAllMocks())

describe('a box on a picture (ADR 0091)', () => {
  it('is the box between the two corners dragged, either way round, inside the picture', () => {
    expect(boxBetween({ x: 0.75, y: 0.5 }, { x: 0.25, y: 0.1 })).toEqual({ kind: 'box', x: 2500, y: 1000, w: 5000, h: 4000 })
    expect(boxBetween({ x: -0.2, y: 0.9 }, { x: 1.4, y: 2 })).toEqual({ kind: 'box', x: 0, y: 9000, w: WHOLE, h: 1000 })
    expect(boxBetween({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, 3)).toEqual({ kind: 'box', x: 5000, y: 5000, w: 1, h: 1, page: 3 })
    expect(wholeBox()).toEqual({ kind: 'box', x: 0, y: 0, w: WHOLE, h: WHOLE })
  })

  it('is named by where it is, in the words a person points with', () => {
    expect(boxLabel(wholeBox())).toBe('The whole picture')
    expect(boxLabel(wholeBox(), 'page 3')).toBe('The whole of page 3')
    expect(boxLabel({ kind: 'box', x: 1000, y: 1000, w: 8000, h: 7000 })).toBe('Most of the picture')
    expect(boxLabel({ kind: 'box', x: 6000, y: 0, w: 4000, h: 3000 })).toBe('The top right of the picture')
    expect(boxLabel({ kind: 'box', x: 0, y: 7000, w: 3000, h: 3000 })).toBe('The bottom left of the picture')
    expect(boxLabel({ kind: 'box', x: 4000, y: 4000, w: 2000, h: 2000 })).toBe('The middle of the picture')
    expect(boxLabel({ kind: 'box', x: 4000, y: 0, w: 2000, h: 1000 })).toBe('The top of the picture')
    expect(boxLabel({ kind: 'box', x: 0, y: 4000, w: 1000, h: 2000 })).toBe('The left side of the picture')
    expect(boxLabel({ kind: 'box', x: 9000, y: 4000, w: 1000, h: 2000 })).toBe('The right side of the picture')
    expect(boxLabel({ kind: 'box', x: 0, y: 0, w: 2000, h: 2000 }, 'page 3')).toBe('The top left of page 3')
  })

  it('is drawn where it is over the picture, however large the picture is shown', () => {
    const at = { kind: 'box' as const, x: 2500, y: 5000, w: 5000, h: 2500 }
    expect(boxStyle(at)).toEqual({ left: '25%', top: '50%', width: '50%', height: '25%' })
    expect(boxOnScreen(at, { top: 100, left: 40, width: 400, height: 200 })).toEqual({ top: 200, left: 140, right: 340, bottom: 250 })
  })

  it('is sent as the picture inside it, at the picture’s own size', async () => {
    const drawn: number[][] = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage: (...args: unknown[]) => { drawn.push(args.slice(1) as number[]) } }) as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, done: BlobCallback) { done(new Blob([`${this.width}x${this.height}`], { type: 'image/png' })) })
    const image = document.createElement('img')
    Object.defineProperty(image, 'naturalWidth', { value: 1600, configurable: true })
    Object.defineProperty(image, 'naturalHeight', { value: 900 })
    const picture = await pictureInside(image, { kind: 'box', x: 5000, y: 0, w: 5000, h: 5000 }, 'chart part.png')
    expect(picture?.name).toBe('chart part.png')
    expect(picture?.type).toBe('image/png')
    expect(drawn).toEqual([[800, 0, 800, 450, 0, 0, 800, 450]])
    expect(await picture?.text()).toBe('800x450')

    // A big picture's part is sent no longer than the daemon would keep it.
    Object.defineProperty(image, 'naturalWidth', { value: 8000 })
    const whole = await pictureInside(image, wholeBox(), 'big part.png')
    expect(await whole?.text()).toBe('2048x230')
  })

  it('sends nothing where the picture can’t be drawn', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null)
    const image = document.createElement('img')
    Object.defineProperty(image, 'naturalWidth', { value: 10 })
    Object.defineProperty(image, 'naturalHeight', { value: 10 })
    expect(await pictureInside(image, wholeBox(), 'x.png')).toBeNull()
    expect(await pictureInside(document.createElement('img'), wholeBox(), 'x.png')).toBeNull()
  })

  it('names the part’s picture after its file', () => {
    expect(partPictureName('chart.svg')).toBe('chart part.png')
    expect(partPictureName('.png')).toBe('picture part.png')
  })
})
