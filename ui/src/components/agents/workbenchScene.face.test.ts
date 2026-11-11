import { Group, Object3D } from 'three'
import { expect, it, vi } from 'vitest'

import { donePose, failedPose, MOOD_FACES, questionPose, restOfFace, WorkbenchScene, type Face, type Pose } from './workbenchScene'

// jsdom has no WebGL: the renderer and the room light made with it are stood in for.
vi.mock('three', async (load) => {
  const three = await load<typeof import('three')>()
  return {
    ...three,
    WebGLRenderer: class { shadowMap = {}; setClearColor() {} render() {} dispose() {} },
    PMREMGenerator: class { fromScene() { return { texture: new three.Texture() } } dispose() {} },
  }
})

const rest = (): Pose => ({ bodyY: 0, bodyRX: 0, bodyRY: 0, neckRX: 0, neckRZ: 0, lookX: 0, lookY: -0.3, armLRX: -1.42, armLRZ: -0.05, armRRX: -1.42, armRRZ: 0.05, scale: 1, band: 0, screen: 0.12, typing: 0, hands: 0, click: 0 })

it('asks with one paw up and holds it: the same pose at any moment, no wave (the review’s motion rules)', () => {
  const asked = rest()
  questionPose(asked)
  expect(asked.armRRZ).toBeLessThan(-2)
  // The other paw stays on the keys.
  expect(asked.armLRX).toBe(-1.42)
  expect(asked.armLRZ).toBe(-0.05)
  // It takes no time: nothing in it can move once it is reached.
  expect(questionPose.length).toBe(1)
  const again = rest()
  questionPose(again)
  expect(again).toEqual(asked)
})

it('is done with both paws up beside its head, one the mirror of the other, held', () => {
  const done = rest()
  donePose(done)
  expect(done.armLRZ).toBeGreaterThan(2)
  expect(done.armRRZ).toBeLessThan(-2)
  expect(done.armLRZ).toBe(-done.armRRZ)
  expect(done.armLRX).toBe(done.armRRX)
})

it('slumps when its work failed: head dropped to one side, hands off the keys, its face still over its collar', () => {
  const failed = rest()
  failedPose(failed)
  expect(Math.abs(failed.neckRZ)).toBeGreaterThan(0.2)
  expect(failed.bodyRX).toBeGreaterThan(0)
  // Nodded, its eyes sank to the neckline and read as buttons on its clothes; a wide build's face went under its collar.
  expect(failed.neckRX + failed.bodyRX).toBeLessThan(0.1)
  expect(failed.neckRZ).not.toBe(0)
  expect(failed.armLRX).toBeGreaterThan(rest().armLRX)
})

it('has a face for each mood, as its stills do: focused at work, brows up asking, eyes shut in a smile when done, worried when it failed', () => {
  expect(MOOD_FACES.still).toEqual({ open: 1, lift: 0, tilt: 0, mouth: 1 })
  expect(MOOD_FACES.working.open).toBeLessThan(0.8)
  expect(MOOD_FACES.working.lift).toBeLessThan(0)
  expect(MOOD_FACES.asking.lift).toBeGreaterThan(0.01)
  expect(MOOD_FACES.done.open).toBeLessThan(0.3)
  expect(MOOD_FACES.done.mouth).toBeGreaterThan(1.2)
  expect(MOOD_FACES.failed.tilt).toBeGreaterThan(0.2)
  expect(MOOD_FACES.failed.mouth).toBeLessThan(1)
})

it('moves its own brows and mouth from where they rest: both inner ends together, the mouth wider or narrower', () => {
  const head = new Group()
  const browL = new Object3D(); browL.name = 'brow_l'; browL.position.y = 0.5; browL.rotation.z = 0.1
  const browR = new Object3D(); browR.name = 'brow_r'; browR.position.y = 0.5; browR.rotation.z = -0.1
  const mouth = new Object3D(); mouth.name = 'mouth'; mouth.scale.x = 2
  head.add(browL, browR, mouth)
  const scene = new WorkbenchScene(document.createElement('canvas'), { onPart() {}, onKey() {}, onHover() {}, onFrame() {} }, false)
  const inside = scene as unknown as { faceRest: ReturnType<typeof restOfFace>; face: Face; showFace(): void }
  inside.faceRest = restOfFace(head)
  inside.face = { ...MOOD_FACES.failed }
  inside.showFace()
  expect(browL.position.y).toBeCloseTo(0.5 + MOOD_FACES.failed.lift)
  expect(browL.rotation.z).toBeCloseTo(0.1 + MOOD_FACES.failed.tilt)
  expect(browR.rotation.z).toBeCloseTo(-0.1 - MOOD_FACES.failed.tilt)
  expect(mouth.scale.x).toBeCloseTo(2 * MOOD_FACES.failed.mouth)
  // Back to rest, exactly where they were.
  inside.face = { ...MOOD_FACES.still }
  inside.showFace()
  expect([browL.position.y, browL.rotation.z, browR.rotation.z, mouth.scale.x]).toEqual([0.5, 0.1, -0.1, 2])
  scene.dispose()
})
