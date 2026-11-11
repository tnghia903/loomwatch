import { describe, expect, it } from 'vitest'
import { CatmullRomCurve3, Mesh, MeshStandardMaterial, Object3D, SphereGeometry, Vector3 } from 'three'
import { CORD, cordGeometry, frontOf, pawMiddle, threadCurve, type ThreadHolder } from './crewScene'

const BELLY = new Vector3(0, 0.25, 0)
const BELLY_RADIUS = 0.3

/**
 * A figure whose paws stand at the sides of its round belly, as the wide build holds the thread: each
 * paw off its hand's pivot by its own amount, as the builds' paws are, not where a fixed point in the
 * hand's space would look for it.
 */
function figure(wave = 0): ThreadHolder & { root: Object3D } {
  const root = new Object3D()
  const body = new Object3D()
  body.name = 'body'
  root.add(body)
  const belly = new Mesh(new SphereGeometry(BELLY_RADIUS, 24, 16), new MeshStandardMaterial())
  belly.position.copy(BELLY)
  body.add(belly)
  const hand = (side: 'l' | 'r') => {
    const arm = new Object3D()
    arm.name = `arm_${side}`
    arm.position.set(side === 'l' ? 0.27 : -0.27, 0.27, 0)
    const pivot = new Object3D()
    pivot.name = `hand_${side}`
    pivot.position.set(0, -0.19, 0)
    const paw = new Mesh(new SphereGeometry(0.05, 12, 8), new MeshStandardMaterial())
    paw.position.set(0, -0.03, 0.08)
    pivot.add(paw)
    arm.add(pivot)
    body.add(arm)
    return { arm, pivot }
  }
  const left = hand('l')
  const right = hand('r')
  // Held forward a little, the paws at the belly's sides; waving, the right one up over the head.
  left.arm.rotation.set(-0.6, 0, 0.4)
  right.arm.rotation.set(wave ? -0.25 : -0.6, 0, wave ? -2.55 : -0.4)
  root.updateMatrixWorld(true)
  return {
    root, body, handL: left.pivot, handR: right.pivot, gripL: pawMiddle(left.pivot), gripR: pawMiddle(right.pivot),
    front: frontOf(body), pose: { wave },
  }
}

const along = (curve: CatmullRomCurve3, count = 2000) => Array.from({ length: count + 1 }, (_, i) => curve.getPointAt(i / count))
const nearest = (points: Vector3[], to: Vector3) => Math.min(...points.map((point) => point.distanceTo(to)))
const middleOf = (hand: Object3D, grip: Vector3) => hand.localToWorld(grip.clone())

describe('the thread the crew holds (threadCurve)', () => {
  it('runs through the middle of each paw', () => {
    const one = figure()
    const points = along(threadCurve([one], 0, true).curve)
    expect(nearest(points, middleOf(one.handL, one.gripL))).toBeLessThan(0.004)
    expect(nearest(points, middleOf(one.handR, one.gripR))).toBeLessThan(0.004)
  })

  it('runs in front of the belly between the paws, never through it', () => {
    const one = figure()
    const points = along(threadCurve([one], 0, true).curve)
    const inside = points.filter((point) => point.distanceTo(BELLY) < BELLY_RADIUS + CORD.radius)
    expect(inside).toEqual([])
  })

  it('goes to the mitten that still holds it while the other waves, across the belly and not through the shoulder', () => {
    const one = figure(1)
    const points = along(threadCurve([one], 0, true).curve)
    expect(nearest(points, middleOf(one.handL, one.gripL))).toBeLessThan(0.004)
    expect(points.filter((point) => point.distanceTo(BELLY) < BELLY_RADIUS + CORD.radius)).toEqual([])
    // The waving mitten, up over the head, is far from it.
    expect(nearest(points, middleOf(one.handR, one.gripR))).toBeGreaterThan(0.2)
  })

  it('says where each figure holds it: between its mittens', () => {
    const { curve, held } = threadCurve([figure(), figure()], 0, true)
    expect(held).toHaveLength(2)
    for (const t of held) expect(curve.getPointAt(t).y).toBeGreaterThan(0)
  })
})

describe('the thread as a cord (cordGeometry)', () => {
  it('is three strands laid round each other: its surface stands out over each and sinks between them', () => {
    const straight = new CatmullRomCurve3([new Vector3(0, 0, 0), new Vector3(0.5, 0, 0), new Vector3(1, 0, 0)])
    const cord = cordGeometry(straight)
    const position = cord.getAttribute('position')
    const ring = CORD.sides + 1
    // One ring, halfway along: how far each of its points stands from the cord's middle.
    const middle = Math.floor(position.count / ring / 2) * ring
    const out = Array.from({ length: CORD.sides }, (_, j) => Math.hypot(position.getY(middle + j), position.getZ(middle + j)))
    expect(Math.max(...out)).toBeCloseTo(CORD.radius * (1 + CORD.depth), 3)
    expect(Math.min(...out)).toBeCloseTo(CORD.radius * (1 - CORD.depth), 3)
    const peaks = out.filter((r, j) => r > out[(j + CORD.sides - 1) % CORD.sides] && r >= out[(j + 1) % CORD.sides])
    expect(peaks).toHaveLength(3)
  })

  it('twists along its length: the strands turn round it once in each lay', () => {
    const straight = new CatmullRomCurve3([new Vector3(0, 0, 0), new Vector3(1, 0, 0)])
    const cord = cordGeometry(straight)
    const position = cord.getAttribute('position')
    const ring = CORD.sides + 1
    const outAt = (i: number, j: number) => Math.hypot(position.getY(i * ring + j), position.getZ(i * ring + j))
    // The same point round the cord, a third of a lay apart along it, stands out by different amounts.
    const third = Math.round(CORD.lay / 3 / CORD.step / 2)
    expect(Math.abs(outAt(0, 0) - outAt(third, 0))).toBeGreaterThan(CORD.radius * CORD.depth * 0.5)
  })
})
