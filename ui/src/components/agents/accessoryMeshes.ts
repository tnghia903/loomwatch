import {
  Box3,
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three'

import type { Accessory } from '../../lib/quests/catalog'

/**
 * The wardrobe's accessories (lib/quests/catalog.ts) on the 3D bench: the same items AccessoryArt
 * draws over the stills, built from simple shapes and placed from the model's own landmarks: the
 * worn head's right eye, its outline, and the hands. Nothing here is clickable: a click on the
 * figure still means its model (lib/library/figure.ts).
 */

/** Where things are on the worn head, in the `head` node's own space. */
export interface HeadLandmarks {
  /** The eye on the viewer's right (`<kind>_eye_r`). */
  eye: Vector3
  /** The head's outline. */
  box: Box3
}

export function landmarks(head: Object3D, worn: Object3D, eye: Object3D): HeadLandmarks {
  head.updateWorldMatrix(true, true)
  const toHead = head.matrixWorld.clone().invert()
  const box = new Box3().setFromObject(worn).applyMatrix4(toHead)
  return { eye: eye.getWorldPosition(new Vector3()).applyMatrix4(toHead), box }
}

/** Geometry and materials made for the accessories, so the bench can dispose of them. */
export interface Made {
  geometries: BufferGeometry[]
  materials: Material[]
}

function maker() {
  const made: Made = { geometries: [], materials: [] }
  const mesh = (geometry: BufferGeometry, material: Material) => {
    made.geometries.push(geometry)
    if (!made.materials.includes(material)) made.materials.push(material)
    const out = new Mesh(geometry, material)
    out.castShadow = true
    return out
  }
  const standard = (color: string, roughness: number, metalness = 0) => {
    const material = new MeshStandardMaterial({ color, roughness, metalness })
    made.materials.push(material)
    return material
  }
  return { made, mesh, standard }
}

/**
 * One accessory, built and placed. Head items go under the `head` node, hand items under the hand
 * on the viewer's side the stills show them on.
 */
export function buildAccessory(item: Accessory, at: HeadLandmarks): { parent: 'head' | 'hand_r' | 'hand_l'; object: Group; made: Made } {
  const { made, mesh, standard } = maker()
  const group = new Group()
  group.name = `wear_${item}`
  const steel = standard('#C9CCD2', 0.3, 0.85)
  const { box, eye } = at
  const width = box.max.x - box.min.x
  // The head as a round at the brow: as far from its middle as the eyes sit in front of it. The
  // outline alone would also take in a yarn ball's loose strands.
  const middle = new Vector3((box.min.x + box.max.x) / 2, eye.y, (box.min.z + box.max.z) / 2)
  const round = Math.min(width / 2, Math.max(0.12, eye.z - middle.z))
  switch (item) {
    case 'monocle': {
      const rim = mesh(new TorusGeometry(0.052, 0.009, 10, 36), steel)
      const glassMaterial = new MeshPhysicalMaterial({ color: '#FFFFFF', roughness: 0.05, transmission: 0.6, transparent: true, opacity: 0.35 })
      made.materials.push(glassMaterial)
      const glass = mesh(new CylinderGeometry(0.05, 0.05, 0.004, 32), glassMaterial)
      glass.rotation.x = Math.PI / 2
      const chain = mesh(new CylinderGeometry(0.0025, 0.0025, 0.16, 6), standard('#B5A584', 0.5, 0.4))
      chain.position.set(0.04, -0.09, -0.01)
      chain.rotation.z = 0.35
      group.add(rim, glass, chain)
      group.position.set(eye.x, eye.y, eye.z + 0.022)
      return { parent: 'head', object: group, made }
    }
    case 'band': {
      const radius = round * 1.02
      const tape = mesh(new TorusGeometry(radius, 0.016, 8, 64), standard('#F4EEDF', 0.7))
      tape.rotation.x = Math.PI / 2
      const buckle = mesh(new BoxGeometry(0.026, 0.04, 0.02), steel)
      buckle.position.set(-radius * 0.71, 0, radius * 0.71)
      buckle.rotation.y = -Math.PI / 4
      group.add(tape, buckle)
      group.position.set(middle.x, eye.y + 0.075, middle.z)
      return { parent: 'head', object: group, made }
    }
    case 'chalk': {
      const chalk = mesh(new CylinderGeometry(0.045, 0.045, 0.02, 3), standard('#E8E1F4', 0.85))
      chalk.rotation.set(Math.PI / 2, 0, 0.45)
      group.add(chalk)
      group.position.set(middle.x + round * 0.95, eye.y + 0.09, middle.z)
      return { parent: 'head', object: group, made }
    }
    case 'patch': {
      const patch = mesh(new BoxGeometry(0.075, 0.07, 0.008), standard('#E6D9BC', 0.95))
      patch.rotation.z = 0.15
      group.add(patch)
      group.position.set(eye.x + 0.06, eye.y - 0.075, eye.z - 0.012)
      return { parent: 'head', object: group, made }
    }
    case 'pin': {
      const loop = mesh(new TorusGeometry(0.012, 0.003, 6, 16), steel)
      loop.position.x = -0.045
      const top = mesh(new CylinderGeometry(0.003, 0.003, 0.085, 6), steel)
      top.rotation.z = Math.PI / 2
      top.position.y = 0.009
      const bottom = top.clone()
      bottom.position.y = -0.009
      const head = mesh(new BoxGeometry(0.025, 0.026, 0.012), standard('#D9DCE0', 0.3, 0.9))
      head.position.x = 0.045
      group.add(loop, top, bottom, head)
      group.rotation.set(0, -1.2, -0.9)
      group.position.set(middle.x - round * 0.98, eye.y, middle.z + round * 0.2)
      return { parent: 'head', object: group, made }
    }
    case 'cushion': {
      const base = mesh(new CylinderGeometry(0.06, 0.06, 0.025, 24), standard('#56704F', 0.8))
      const dome = mesh(new SphereGeometry(0.055, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), standard('#7FA27A', 0.75))
      dome.position.y = 0.012
      group.add(base, dome)
      for (const [index, color] of ['#EFE6D4', '#BDB0E6', '#3A372F'].entries()) {
        const pin = mesh(new CylinderGeometry(0.0025, 0.0025, 0.06, 6), steel)
        pin.position.set(-0.02 + index * 0.02, 0.07, 0)
        pin.rotation.z = (index - 1) * 0.35
        const top = mesh(new SphereGeometry(0.009, 10, 8), standard(color, 0.4))
        top.position.y = 0.03
        pin.add(top)
        group.add(pin)
      }
      group.position.set(0, 0.0, 0.05)
      return { parent: 'hand_r', object: group, made }
    }
    case 'shuttle': {
      const body = mesh(new SphereGeometry(0.05, 24, 12), standard('#C9A27A', 0.55))
      body.scale.set(1.9, 0.45, 0.65)
      const bobbin = mesh(new CylinderGeometry(0.018, 0.018, 0.05, 16), standard('#BDB0E6', 0.6))
      bobbin.rotation.z = Math.PI / 2
      bobbin.position.z = 0.02
      group.add(body, bobbin)
      group.rotation.z = -0.25
      group.position.set(0, 0.0, 0.06)
      return { parent: 'hand_l', object: group, made }
    }
  }
}
