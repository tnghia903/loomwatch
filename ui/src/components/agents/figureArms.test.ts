import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DoubleSide, Mesh, Raycaster, Vector3, type Object3D } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'

import { REST as CREW_HOLDING } from '../../site/crewScene'
import { failedPose, type Pose } from './workbenchScene'

// The arms are stubby and hang from shoulders inside a round body: held where the body bulges, a paw
// lies inside it, under its fur and clothes, and the figure looks armless.
const BUILDS = ['tall', 'chubby', 'little', 'slim', 'egg', 'wide'] as const

async function figure(build: string): Promise<Object3D> {
  const bytes = readFileSync(resolve(process.cwd(), `public/agent/figure/${build}.glb`))
  // An ArrayBuffer of the test's own window: the loader tells a binary file from text by its kind.
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  const gltf = await new GLTFLoader().parseAsync(copy, '')
  return gltf.scene
}

/** How far each paw's middle stands out of the body, across from the body's axis at its height. */
function pawsOut(root: Object3D, arms: { lx: number; lz: number; rx: number; rz: number }): number[] {
  const torso = root.getObjectByName('torso') as Mesh
  torso.material = Object.assign((torso.material as Mesh['material'] & object), { side: DoubleSide })
  root.getObjectByName('arm_l')!.rotation.set(arms.lx, 0, arms.lz)
  root.getObjectByName('arm_r')!.rotation.set(arms.rx, 0, arms.rz)
  root.updateMatrixWorld(true)
  return ['l', 'r'].map((side) => {
    const paw = root.getObjectByName(`hand_${side}_mitten`) as Mesh
    paw.geometry.computeBoundingBox()
    const middle = paw.geometry.boundingBox!.getCenter(new Vector3()).applyMatrix4(paw.matrixWorld)
    const axis = new Vector3(0, middle.y, 0)
    const way = middle.clone().sub(axis)
    const hits = new Raycaster(axis, way.clone().normalize(), 0, 2).intersectObject(torso, false)
    return way.length() - (hits.at(-1)?.distance ?? 0)
  })
}

describe('a live figure’s arms show', () => {
  it.each(BUILDS)('on the landing page’s %s figure holding the thread, its paws out in front of its body', async (build) => {
    const out = pawsOut(await figure(build), { lx: CREW_HOLDING.armLRX, lz: CREW_HOLDING.armLRZ, rx: CREW_HOLDING.armRRX, rz: CREW_HOLDING.armRRZ })
    // The widest belly (wide) leaves its paws' middles about 2 cm out, and their fronts well clear.
    for (const paw of out) expect(paw).toBeGreaterThan(0.015)
  })

  it.each(BUILDS)('on the bench’s %s figure when its work failed, its paws at its sides', async (build) => {
    const pose = { armLRX: 0, armLRZ: 0, armRRX: 0, armRRZ: 0 } as Pose
    failedPose(pose)
    const out = pawsOut(await figure(build), { lx: pose.armLRX, lz: pose.armLRZ, rx: pose.armRRX, rz: pose.armRRZ })
    for (const paw of out) expect(paw).toBeGreaterThan(0.04)
  })

  it.each(BUILDS)('on the bench’s %s figure in each garment, its paws in front of the cloth at the keys, asking and failed', async (build) => {
    const root = await figure(build)
    const garments: Mesh[] = []
    root.traverse((object) => { if (object instanceof Mesh && /^wear_(striped_top|cardigan|trench_coat|black_dress)_pose_(rest|ask|failed)$/.test(object.name)) garments.push(object) })
    expect(garments).toHaveLength(12)
    for (const garment of garments) {
      root.getObjectByName('arm_l')!.rotation.set(...(garment.userData.bind_arm_l as [number, number, number]))
      root.getObjectByName('arm_r')!.rotation.set(...(garment.userData.bind_arm_r as [number, number, number]))
      root.updateMatrixWorld(true)
      garment.material = Object.assign(garment.material as object, { side: DoubleSide }) as Mesh['material']
      for (const side of ['l', 'r']) {
        // Of the paw's points facing the front, how many the cloth leaves in sight from the front and
        // a little above, as the bench and the page see it.
        const paw = root.getObjectByName(`hand_${side}_mitten`) as Mesh
        const position = paw.geometry.getAttribute('position')
        const normal = paw.geometry.getAttribute('normal')
        const look = new Vector3(0, 0.3, 1).normalize()
        let facing = 0
        let shown = 0
        for (let i = 0; i < position.count; i += 7) {
          if (new Vector3().fromBufferAttribute(normal, i).transformDirection(paw.matrixWorld).z < 0.3) continue
          facing += 1
          const at = new Vector3().fromBufferAttribute(position, i).applyMatrix4(paw.matrixWorld).addScaledVector(look, 0.001)
          if (new Raycaster(at, look).intersectObject(garment, false).length === 0) shown += 1
        }
        expect(shown / facing, `${garment.name} ${side}`).toBeGreaterThan(0.8)
      }
    }
  })

  it('measures a paw inside the body as inside', async () => {
    // The crew's old hold: forward and in at the waist.
    const out = pawsOut(await figure('wide'), { lx: -0.62, lz: -0.16, rx: -0.62, rz: 0.16 })
    for (const paw of out) expect(paw).toBeLessThan(0)
  })
})

