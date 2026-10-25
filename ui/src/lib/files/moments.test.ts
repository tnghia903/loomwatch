import { afterEach, describe, expect, it, vi } from 'vitest'

import { clockTime, framesOf, frameTimes, timeBetween, timeLabel } from './moments'

afterEach(() => vi.restoreAllMocks())

describe('a moment or a span of a recording (ADR 0091)', () => {
  it('is named as a player shows time', () => {
    expect([0, 999, 42_000, 61_400, 599_600, 3_723_000].map(clockTime)).toEqual(['0:00', '0:01', '0:42', '1:01', '10:00', '1:02:03'])
    expect(timeLabel({ kind: 'time', start: 42_000 })).toBe('The moment at 0:42')
    expect(timeLabel({ kind: 'time', start: 42_000, end: 51_000 })).toBe('From 0:42 to 0:51')
  })

  it('is a span between two moments either way round, and a moment when they are under a second apart', () => {
    expect(timeBetween(51_000.4, 42_000)).toEqual({ kind: 'time', start: 42_000, end: 51_000 })
    expect(timeBetween(42_000, 42_600)).toEqual({ kind: 'time', start: 42_000 })
    expect(timeBetween(-5, 0)).toEqual({ kind: 'time', start: 0 })
  })

  it('is sent as its frame, a span as its first, middle and last, a box as its frame', () => {
    expect(frameTimes({ kind: 'time', start: 42_000 })).toEqual([42_000])
    expect(frameTimes({ kind: 'time', start: 40_000, end: 50_000 })).toEqual([40_000, 45_000, 50_000])
    expect(frameTimes({ kind: 'box', x: 0, y: 0, w: 10_000, h: 10_000, ms: 7_000 })).toEqual([7_000])
    expect(frameTimes({ kind: 'box', x: 0, y: 0, w: 10_000, h: 10_000 })).toEqual([])
  })

  it('takes each frame at its moment, cut to a box when there is one, and leaves the recording where it was', async () => {
    const drawn: number[][] = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage: (...args: unknown[]) => { drawn.push(args.slice(1, 5) as number[]) } }) as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, done: BlobCallback) { done(new Blob([`${this.width}x${this.height}`], { type: 'image/png' })) })
    const video = document.createElement('video')
    Object.defineProperty(video, 'videoWidth', { value: 1920 })
    Object.defineProperty(video, 'videoHeight', { value: 1080 })
    Object.defineProperty(video, 'readyState', { value: 4 })
    let time = 12
    const seekedAt: number[] = []
    Object.defineProperty(video, 'currentTime', {
      get: () => time,
      set: (value: number) => { time = value; seekedAt.push(value); queueMicrotask(() => video.dispatchEvent(new Event('seeked'))) },
    })
    vi.spyOn(video, 'pause').mockImplementation(() => undefined)
    const frames = await framesOf(video, [40_000, 45_000], (index) => `talk ${index}.png`)
    expect(frames.map((frame) => frame.name)).toEqual(['talk 0.png', 'talk 1.png'])
    expect(await frames[0].text()).toBe('1600x900')
    expect(seekedAt).toEqual([40, 45, 12])
    expect(drawn).toEqual([[0, 0, 1920, 1080], [0, 0, 1920, 1080]])

    drawn.length = 0
    const [part] = await framesOf(video, [7_000], () => 'part.png', { kind: 'box', x: 5000, y: 0, w: 5000, h: 5000, ms: 7_000 })
    expect(drawn).toEqual([[960, 0, 960, 540]])
    expect(await part.text()).toBe('960x540')
  })

  it('sends no frames of a recording not yet loaded', async () => {
    expect(await framesOf(document.createElement('video'), [1_000], () => 'x.png')).toEqual([])
  })
})
