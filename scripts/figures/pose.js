// The portrait's pose, kept in step with STILL_POSE and STILL_HEAD in the Blender script that makes the
// starter stills: arms relaxed a little out and forward, head tilted toward you. Blender turns about its
// own axes (z up) and this model is y up, so each turn is carried across as a quaternion.
import * as THREE from 'three'

const ARMS = { forward: -0.55, out: 0.38 }
const HEAD = [-4, -9, 4].map((degrees) => (degrees * Math.PI) / 180)

function fromBlender(x, y, z) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ'))
  return new THREE.Quaternion(q.x, q.z, -q.y, q.w)
}

export function portrait(fig) {
  fig.getObjectByName('arm_l').quaternion.copy(fromBlender(ARMS.forward, ARMS.out, 0))
  fig.getObjectByName('arm_r').quaternion.copy(fromBlender(ARMS.forward, -ARMS.out, 0))
  fig.getObjectByName('head').quaternion.copy(fromBlender(...HEAD))
}
