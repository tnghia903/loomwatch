import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { WorkbenchScene, type BenchView } from './workbenchScene'

// jsdom has no WebGL: the renderer, and the room light made with it, are stood in for. What is
// counted here is how often the bench draws, not what it draws.
vi.mock('three', async (load) => {
  const three = await load<typeof import('three')>()
  return {
    ...three,
    WebGLRenderer: class { shadowMap = {}; domElement = document.createElement('canvas'); setClearColor() {} setDrawingBufferSize() {} render() {} dispose() {} },
    PMREMGenerator: class { fromScene() { return { texture: new three.Texture() } } dispose() {} },
  }
})

type Inside = { loaded: boolean; frame(): void; update(dt: number): void; actions: { kind: string; start: number; duration: number }[]; now: number }

const queued: FrameRequestCallback[] = []
let clock = 0
beforeEach(() => {
  queued.length = 0
  clock = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => queued.push(callback))
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const view = (mood: BenchView['mood']) => ({ mood, dropping: false }) as unknown as BenchView

/** A loaded bench, drawing, whose frames are counted (its model and pose are left out). */
function bench(mood: BenchView['mood']) {
  const scene = new WorkbenchScene(document.createElement('canvas'), { onPart() {}, onKey() {}, onHover() {}, onFrame() {} }, false)
  const inside = scene as unknown as Inside
  scene.set(view(mood))
  inside.loaded = true
  const drawn = vi.spyOn(inside, 'frame').mockImplementation(() => {})
  vi.spyOn(inside, 'update').mockImplementation(() => {})
  scene.start()
  return { scene, inside, drawn }
}

/** A second of a 60 Hz screen's frames; how many of them it drew. */
function aSecond(drawn: { mock: { calls: unknown[] } }) {
  const before = drawn.mock.calls.length
  for (let frame = 0; frame < 60; frame += 1) {
    clock += 1000 / 60
    queued.shift()?.(clock)
  }
  return drawn.mock.calls.length - before
}

it('draws half as often once it rests, and every frame while it works', () => {
  const resting = bench('still')
  aSecond(resting.drawn)
  expect(aSecond(resting.drawn)).toBe(30)
  resting.scene.dispose()

  const working = bench('working')
  aSecond(working.drawn)
  expect(aSecond(working.drawn)).toBe(60)
  working.scene.dispose()
})

it('draws every frame while something moves, and for a second after', () => {
  const { scene, inside, drawn } = bench('done')
  aSecond(drawn)
  expect(aSecond(drawn)).toBe(30)

  // Your pointer moving over it: it follows, then settles.
  scene.pointerMove(120, 80)
  expect(aSecond(drawn)).toBe(60)
  expect(aSecond(drawn)).toBe(30)

  // A reaction to something you changed, under way.
  inside.actions.push({ kind: 'nameplate', start: inside.now, duration: 1.4 })
  expect(aSecond(drawn)).toBe(60)
  inside.actions.length = 0
  expect(aSecond(drawn)).toBe(60)
  expect(aSecond(drawn)).toBe(30)
  scene.dispose()
})

it('draws again as soon as its size changes, before the page is painted: a new size empties its canvas', () => {
  const { scene, drawn } = bench('still')
  // Shown after it was set up out of sight: its stage goes from nothing to its size.
  scene.resize(440, 300)
  expect(drawn).toHaveBeenCalledTimes(1)
  scene.dispose()
})
