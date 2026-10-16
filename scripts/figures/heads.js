// Builds head_scissors and head_bobbin in workbench.glb's own conventions: under figure/body/neck/head,
// face toward +z, materials named by their role (benchMaterial), eyes named <kind>_eye_[lr] with
// _mesh and _glint children so the bench's blink finds them.
import * as THREE from 'three'

const role = (name) => { const m = new THREE.MeshStandardMaterial({ color: '#888' }); m.name = name; return m }
const mat = { skin: role('skin'), skin_deep: role('skin_deep'), skin_wound: role('skin_wound'), steel: role('steel'), eye: role('eye'), stitch: role('stitch'), wood: role('wood') }

function mesh(name, geometry, material, at = [0, 0, 0], rotation = [0, 0, 0]) {
  const m = new THREE.Mesh(geometry, material)
  m.name = name
  m.position.set(...at)
  m.rotation.set(...rotation)
  return m
}

/** A face like the spool's: two eyes and a stitched smile, cloned from the GLB so they match. */
function face(kind, gltf, at, spread, mouthDrop) {
  const source = gltf.scene.getObjectByName('spool_face')
  const out = new THREE.Group()
  out.name = `${kind}_face`
  out.position.set(...at)
  for (const side of ['l', 'r']) {
    const eye = source.getObjectByName(`spool_eye_${side}`).clone(true)
    eye.name = `${kind}_eye_${side}`
    eye.position.set(side === 'l' ? -spread : spread, 0, 0)
    eye.traverse((child) => { if (child !== eye) child.name = child.name.replace('spool_', `${kind}_`) })
    out.add(eye)
  }
  const mouth = source.getObjectByName('spool_mouth').clone(true)
  mouth.name = `${kind}_mouth`
  mouth.position.set(0, -mouthDrop, 0)
  mouth.traverse((child) => { if (child !== mouth) child.name = child.name.replace('spool_', `${kind}_`) })
  out.add(mouth)
  out.traverse((child) => { if (child.isMesh) child.material = mat[child.material.name] ?? role(child.material.name) })
  return out
}

export function bobbin(gltf) {
  const head = new THREE.Group()
  head.name = 'head_bobbin'
  head.position.set(0, 0.02, 0)
  const flange = new THREE.CylinderGeometry(0.34, 0.34, 0.026, 40)
  head.add(mesh('bobbin_flange_bottom', flange, mat.steel, [0, 0.013, 0]))
  head.add(mesh('bobbin_flange_top', flange, mat.steel, [0, 0.317, 0]))
  // The thread, wound a little proud of the flanges' middle, with a loose end down its side.
  head.add(mesh('bobbin_thread', new THREE.CylinderGeometry(0.3, 0.3, 0.278, 40, 1, true), mat.skin_wound, [0, 0.165, 0]))
  for (let i = 0; i < 6; i += 1) head.add(mesh(`bobbin_wind${i}`, new THREE.TorusGeometry(0.3, 0.009, 5, 40), mat.skin_deep, [0, 0.05 + i * 0.044, 0], [Math.PI / 2, 0, 0]))
  const tail = new THREE.CatmullRomCurve3([new THREE.Vector3(0.22, 0.3, 0.2), new THREE.Vector3(0.3, 0.2, 0.13), new THREE.Vector3(0.32, 0.07, 0.11), new THREE.Vector3(0.33, -0.02, 0.13)])
  head.add(mesh('bobbin_tail', new THREE.TubeGeometry(tail, 16, 0.011, 6, false), mat.skin_deep))
  head.add(mesh('bobbin_hub', new THREE.CylinderGeometry(0.06, 0.06, 0.03, 20), mat.steel, [0, 0.343, 0]))
  head.add(mesh('bobbin_hole', new THREE.CylinderGeometry(0.032, 0.032, 0.004, 16), mat.eye, [0, 0.36, 0]))
  head.add(face('bobbin', gltf, [0, 0.19, 0.305], 0.05, 0.075))
  return head
}

export function scissors(gltf) {
  const head = new THREE.Group()
  head.name = 'head_scissors'
  head.position.set(0, 0, 0)
  // Two finger rings side by side, the eyes inside them.
  for (const [side, x] of [['l', -0.14], ['r', 0.14]]) {
    head.add(mesh(`scissors_ring_${side}`, new THREE.TorusGeometry(0.115, 0.05, 14, 40), mat.skin, [x, 0.17, 0]))
    head.add(mesh(`scissors_hollow_${side}`, new THREE.CylinderGeometry(0.075, 0.075, 0.05, 28), mat.skin_deep, [x, 0.17, -0.005], [Math.PI / 2, 0, 0]))
  }
  // The shanks from each ring up to the pivot, then the blades crossing above it.
  const shank = new THREE.CylinderGeometry(0.035, 0.045, 0.2, 14)
  head.add(mesh('scissors_shank_l', shank, mat.skin, [-0.07, 0.33, 0], [0, 0, -0.62]))
  head.add(mesh('scissors_shank_r', shank, mat.skin, [0.07, 0.33, 0], [0, 0, 0.62]))
  const blade = new THREE.Shape()
  blade.moveTo(-0.034, 0)
  blade.lineTo(0.034, 0)
  blade.quadraticCurveTo(0.03, 0.12, 0.004, 0.2)
  blade.lineTo(-0.008, 0.2)
  blade.quadraticCurveTo(-0.034, 0.1, -0.034, 0)
  const bladeGeometry = new THREE.ExtrudeGeometry(blade, { depth: 0.016, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 2, curveSegments: 8 })
  head.add(mesh('scissors_blade_l', bladeGeometry, mat.steel, [0.01, 0.36, -0.03], [0, 0, 0.36]))
  head.add(mesh('scissors_blade_r', bladeGeometry, mat.steel, [-0.01, 0.36, 0.0], [0, 0, -0.36]))
  head.add(mesh('scissors_pivot', new THREE.CylinderGeometry(0.035, 0.035, 0.05, 16), mat.steel, [0, 0.38, 0.01], [Math.PI / 2, 0, 0]))
  const eyes = face('scissors', gltf, [0, 0.17, 0.02], 0.14, 0.12)
  head.add(eyes)
  return head
}
