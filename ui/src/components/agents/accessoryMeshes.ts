import {
  Box3,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Float32BufferAttribute,
  Group,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Quaternion,
  Raycaster,
  RepeatWrapping,
  RingGeometry,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  type Material,
  type Object3D,
  type Texture,
} from 'three'
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js'

import type { Accessory } from '../../lib/quests/catalog'

/**
 * The wardrobe's accessories (lib/quests/catalog.ts), worn the way a tailor wears them and fitted
 * to the figure's own model: the tape measure lies over the shoulders and hangs down the chest, the
 * monocle is a button with a lens in it, tied to the scarf with plum thread, the chalk is tucked
 * behind an ear and has drawn a cut line on the tummy, the patch is sewn onto the tummy's curve, a
 * safety pin fastens the scarf, the pincushion is strapped round a wrist and a shuttle is pushed
 * through the top of the head, as needles are stuck in a ball of yarn. Each is placed by casting
 * rays onto the body, so it sits on the surface of whichever figure wears it.
 *
 * The 3D bench dresses its figure with this, and scripts/figures renders the stills' accessory
 * layers (ui/public/agent/wear) from it too, so the pictures and the bench always agree. Nothing
 * here is clickable: a click on the figure still means its model (lib/library/figure.ts).
 */

export interface Dressed {
  /** Take off everything this put on, and free it. */
  undress: () => void
}

export interface DressOptions {
  /**
   * Moves what sits on the face, in world space. The stills were drawn from the original model,
   * whose faces sit a little apart from this one's; their accessory layers are rendered with the
   * measured difference, so the monocle lands on the eye in the picture.
   */
  faceNudge?: Vector3
}

/**
 * A tailor's plum thread: the one colour on a figure that is not its own. Like everything a figure
 * wears, never one of the app's status colours (lib/library/figures.ts FIGURE_COLORS): a red thread
 * read as trouble, and a gold pin as you.
 */
const THREAD = '#7B3F73'
/** A pearl pin head's pink, beside a white one and one in the thread's plum. */
const PEARL = '#EFB8CC'

type Draw = (context: CanvasRenderingContext2D, width: number, height: number) => void

interface Kit {
  steel: MeshStandardMaterial
  made: { dispose: () => void }[]
  mesh: (geometry: BufferGeometry, material: Material) => Mesh
  standard: (color: string, roughness: number, metalness?: number) => MeshStandardMaterial
  own: <T extends { dispose: () => void }>(item: T) => T
  texture: (draw: Draw, width: number, height: number) => Texture
}

function kit(): Kit {
  const made: { dispose: () => void }[] = []
  const own = <T extends { dispose: () => void }>(item: T) => { made.push(item); return item }
  const mesh = (geometry: BufferGeometry, material: Material) => {
    own(geometry)
    const out = new Mesh(geometry, material)
    out.castShadow = true
    out.receiveShadow = true
    return out
  }
  const standard = (color: string, roughness: number, metalness = 0) => own(new MeshStandardMaterial({ color, roughness, metalness }))
  const texture = (draw: Draw, width: number, height: number) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (context) draw(context, width, height)
    const out = own(new CanvasTexture(canvas))
    out.colorSpace = SRGBColorSpace
    out.anisotropy = 4
    return out
  }
  return { steel: standard('#C9CCD2', 0.28, 0.9), made, mesh, standard, own, texture }
}

/** Meshes under `root` that are drawn now: the worn head, not the others. */
function shown(root: Object3D): Mesh[] {
  const out: Mesh[] = []
  root.traverseVisible((object) => { if (object instanceof Mesh) out.push(object) })
  return out
}

const ray = new Raycaster()

/** Where a ray from `from` toward `to` first meets `targets`, with the surface's outward normal. */
function hit(targets: Mesh[], from: Vector3, to: Vector3): { point: Vector3; normal: Vector3 } | null {
  const direction = to.clone().sub(from).normalize()
  ray.set(from, direction)
  ray.far = from.distanceTo(to) * 2
  const found = ray.intersectObjects(targets, false)[0]
  if (!found?.face) return null
  const normal = found.face.normal.clone().transformDirection(found.object.matrixWorld)
  if (normal.dot(direction) > 0) normal.negate()
  return { point: found.point.clone(), normal }
}

/**
 * Lay a path onto a body: each point is pushed in toward `axis` until it meets the surface, then
 * lifted off it by `lift`. Returns the points and the surface normals under them.
 */
function drape(path: Vector3[], targets: Mesh[], axis: (point: Vector3) => Vector3, lift: number): { points: Vector3[]; normals: Vector3[] } {
  // Smooth the path first, then lay every point of it on the surface: smoothing after would pull a
  // path that wraps round the body inside it.
  const points = new CatmullRomCurve3(path, false, 'centripetal').getSpacedPoints(64)
  const laid: Vector3[] = []
  const normals: Vector3[] = []
  for (const point of points) {
    const centre = axis(point)
    const out = point.clone().sub(centre).normalize()
    const found = hit(targets, point.clone().addScaledVector(out, 0.4), centre)
    laid.push(found ? found.point.addScaledVector(found.normal, lift) : point.clone())
    normals.push(found ? found.normal : out)
  }
  return { points: laid, normals }
}

/** A flat ribbon along `points`, lying on the surface whose normals are given, `width` across. */
function ribbon(points: Vector3[], normals: Vector3[], width: number, samples = 160): BufferGeometry {
  const curve = new CatmullRomCurve3(points, false, 'centripetal')
  const normalCurve = new CatmullRomCurve3(normals.map((normal) => normal.clone()), false)
  const positions: number[] = []
  const uvs: number[] = []
  const faces: number[] = []
  const indices: number[] = []
  const length = curve.getLength()
  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples
    const at = curve.getPointAt(t)
    const along = curve.getTangentAt(t)
    const up = normalCurve.getPoint(t).normalize()
    const across = new Vector3().crossVectors(along, up).normalize()
    const face = new Vector3().crossVectors(across, along).normalize()
    for (const side of [-1, 1]) {
      const point = at.clone().addScaledVector(across, (side * width) / 2)
      positions.push(point.x, point.y, point.z)
      faces.push(face.x, face.y, face.z)
      uvs.push((t * length) / (width * 7), side < 0 ? 0 : 1)
    }
    if (i < samples) {
      const a = i * 2
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new Float32BufferAttribute(faces, 3))
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  return geometry
}

/** A rotation turning +z to face along `normal`, keeping +y as upright as the surface allows. */
function facing(normal: Vector3, twist = 0): Quaternion {
  const z = normal.clone().normalize()
  const x = new Vector3(0, 1, 0).cross(z).normalize()
  if (x.lengthSq() < 1e-6) x.set(1, 0, 0)
  const y = z.clone().cross(x).normalize()
  const turn = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z))
  return twist ? turn.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), twist)) : turn
}

// ── Textures ───────────────────────────────────────────────────────────────────────────────────

function tapeTexture(k: Kit): Texture {
  const texture = k.texture((g, w, h) => {
    g.fillStyle = '#F6F1E3'
    g.fillRect(0, 0, w, h)
    // A tick every few pixels along both edges, longer every five, a number every ten.
    for (let x = 4, n = 0; x < w; x += 9, n += 1) {
      const long = n % 10 === 0 ? 0.4 : n % 5 === 0 ? 0.28 : 0.16
      g.fillStyle = '#2B2925'
      g.fillRect(x, 0, 1.8, h * long)
      g.fillRect(x, h * (1 - long), 1.8, h * long)
      if (n % 10 === 5) {
        g.fillStyle = n % 50 === 5 ? THREAD : '#2B2925'
        g.font = `700 ${Math.round(h * 0.34)}px sans-serif`
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        g.fillText(String(Math.ceil(n / 10)), x, h / 2)
      }
    }
  }, 512, 48)
  texture.wrapS = RepeatWrapping
  return texture
}

function patchTexture(k: Kit): Texture {
  return k.texture((g, w, h) => {
    const inset = w * 0.06
    // Gingham: a warm red check on cream.
    g.fillStyle = '#F3E9D6'
    g.beginPath()
    g.roundRect(inset, inset, w - 2 * inset, h - 2 * inset, w * 0.05)
    g.fill()
    g.save()
    g.clip()
    const step = w / 9
    g.fillStyle = 'rgba(184, 74, 63, 0.45)'
    for (let x = 0; x < w; x += step * 2) g.fillRect(x, 0, step, h)
    for (let y = 0; y < h; y += step * 2) g.fillRect(0, y, w, step)
    g.restore()
    // The running stitch that sews it on, just inside the edge.
    g.strokeStyle = '#3A2F28'
    g.lineWidth = w * 0.024
    g.lineCap = 'round'
    g.setLineDash([w * 0.05, w * 0.04])
    g.beginPath()
    g.roundRect(inset * 2.2, inset * 2.2, w - 4.4 * inset, h - 4.4 * inset, w * 0.03)
    g.stroke()
    // A cross-stitch in each corner, where it was pulled tight.
    g.setLineDash([])
    for (const [cx, cy] of [[inset * 2.2, inset * 2.2], [w - inset * 2.2, inset * 2.2], [inset * 2.2, h - inset * 2.2], [w - inset * 2.2, h - inset * 2.2]]) {
      const s = w * 0.035
      g.beginPath()
      g.moveTo(cx - s, cy - s); g.lineTo(cx + s, cy + s)
      g.moveTo(cx + s, cy - s); g.lineTo(cx - s, cy + s)
      g.stroke()
    }
  }, 256, 256)
}

function chalkLineTexture(k: Kit): Texture {
  return k.texture((g, w, h) => {
    // A tailor's cut line: dashes of chalk along a gentle curve, and a cross where to cut.
    g.strokeStyle = 'rgba(248, 245, 253, 0.95)'
    g.lineWidth = h * 0.1
    g.lineCap = 'round'
    g.setLineDash([w * 0.045, w * 0.032])
    g.beginPath()
    g.moveTo(w * 0.05, h * 0.66)
    g.quadraticCurveTo(w * 0.48, h * 0.26, w * 0.82, h * 0.5)
    g.stroke()
    g.setLineDash([])
    g.lineWidth = h * 0.08
    g.beginPath()
    g.moveTo(w * 0.88, h * 0.34); g.lineTo(w * 0.96, h * 0.64)
    g.moveTo(w * 0.96, h * 0.34); g.lineTo(w * 0.88, h * 0.64)
    g.stroke()
  }, 512, 128)
}

// ── The figure ─────────────────────────────────────────────────────────────────────────────────

interface Body {
  figure: Object3D
  body: Object3D
  head: Object3D
  torso: Mesh
  scarf: Mesh
  /** The worn head's eye on the viewer's right. */
  eye: Object3D
  /** The hand on the viewer's left, whose wrist wears the pincushion. */
  hand: Object3D
  /** The figure's size in the world, and which way it faces. */
  scale: number
  turn: Quaternion
  base: Vector3
  /** A point of the figure's own space (its body at the origin), in world space. */
  at: (x: number, y: number, z: number) => Vector3
  /** The body's upright axis at the height of `point`, in world space. */
  axis: (point: Vector3) => Vector3
}

function bodyOf(figure: Object3D, kind: string): Body | null {
  const names = ['body', 'head', 'torso', 'scarf', `${kind}_eye_r`, 'hand_r']
  const nodes = names.map((name) => figure.getObjectByName(name))
  if (nodes.some((node) => !node)) return null
  const [body, head, torso, scarf, eye, hand] = nodes as Object3D[]
  figure.updateWorldMatrix(true, true)
  const base = body.getWorldPosition(new Vector3())
  const scale = figure.getWorldScale(new Vector3()).x
  const turn = figure.getWorldQuaternion(new Quaternion())
  return {
    figure, body, head, torso: torso as Mesh, scarf: scarf as Mesh, eye, hand, scale, turn, base,
    at: (x, y, z) => new Vector3(x, y, z).applyQuaternion(turn).multiplyScalar(scale).add(base),
    axis: (point) => new Vector3(base.x, point.y, base.z),
  }
}

// ── The accessories ────────────────────────────────────────────────────────────────────────────

/** The tailor's tape: round the back of the neck, over the shoulders, down both sides of the chest. */
function tape(k: Kit, b: Body): Object3D {
  const s = b.scale
  // The left end hangs lower than the right, the way a tape thrown over the shoulders falls.
  const path = [
    b.at(-0.08, 0.14, 0.25), b.at(-0.095, 0.2, 0.24), b.at(-0.115, 0.26, 0.21), b.at(-0.15, 0.315, 0.13), b.at(-0.17, 0.33, 0.02),
    b.at(-0.13, 0.33, -0.12), b.at(0, 0.33, -0.19), b.at(0.13, 0.33, -0.12),
    b.at(0.17, 0.33, 0.02), b.at(0.15, 0.315, 0.13), b.at(0.115, 0.26, 0.21), b.at(0.095, 0.2, 0.24),
  ]
  const { points, normals } = drape(path, [b.torso, b.scarf], (point) => b.axis(point).add(new Vector3(0, -0.12 * s, 0)), 0.005 * s)
  const material = k.own(new MeshStandardMaterial({ map: tapeTexture(k), roughness: 0.7, side: DoubleSide }))
  const group = new Group()
  group.name = 'wear_band'
  group.add(k.mesh(ribbon(points, normals, 0.034 * s), material))
  // A nickel tip on each end: brass would read as your gold.
  for (const end of [0, points.length - 1]) {
    const next = points[end === 0 ? 1 : end - 1]
    const along = points[end].clone().sub(next).normalize()
    const tip = k.mesh(new CylinderGeometry(0.021 * s, 0.021 * s, 0.012 * s, 4, 1), k.steel)
    tip.position.copy(points[end]).addScaledVector(along, 0.004 * s)
    tip.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), along).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 4))
    tip.scale.set(1, 1, 0.22)
    group.add(tip)
  }
  return group
}

/** A lens set in a big four-hole button, on the eye, tied to the scarf with plum thread. */
function monocle(k: Kit, b: Body, nudge: Vector3): Object3D {
  const s = b.scale
  const eye = b.eye.getWorldPosition(new Vector3()).add(nudge)
  const front = new Vector3(0, 0, 1).applyQuaternion(b.turn)
  const surface = hit(shown(b.head), eye.clone().addScaledVector(front, 0.5), eye.clone().addScaledVector(front, -0.2))
  const normal = surface ? surface.normal.clone().lerp(front, 0.35).normalize() : front
  const centre = (surface ? surface.point : eye).clone().addScaledVector(normal, 0.02 * s)
  const radius = 0.058 * s
  const group = new Group()
  group.name = 'wear_monocle'
  // The button: a raised rim and a dished middle, the lens set in it, four holes for the thread.
  const profile = [[0.72, -0.1], [0.72, 0.1], [0.82, 0.17], [0.97, 0.14], [1, 0], [0.97, -0.12], [0.8, -0.14]].map(([r, y]) => new Vector2(r * radius, y * radius))
  const rim = k.mesh(new LatheGeometry(profile, 48), k.own(new MeshPhysicalMaterial({ color: '#EDE5D2', roughness: 0.32, clearcoat: 0.8, clearcoatRoughness: 0.2 })))
  rim.rotation.x = Math.PI / 2
  const lens = k.mesh(new CylinderGeometry(radius * 0.74, radius * 0.74, 0.004 * s, 40), k.own(new MeshPhysicalMaterial({ color: '#FFFFFF', roughness: 0.04, transparent: true, opacity: 0.2, clearcoat: 1 })))
  lens.rotation.x = Math.PI / 2
  lens.castShadow = false
  const glint = k.mesh(new RingGeometry(radius * 0.32, radius * 0.44, 24, 1, 2.1, 1.0), k.own(new MeshStandardMaterial({ color: '#FFFFFF', emissive: '#FFFFFF', emissiveIntensity: 0.5, transparent: true, opacity: 0.8 })))
  glint.position.z = 0.004 * s
  glint.castShadow = false
  const button = new Group()
  button.add(rim, lens, glint)
  const hole = k.standard('#5A4E44', 0.85)
  const holes = [0.5, 1.15, 1.95, 2.6].map((angle) => new Vector3(Math.cos(angle + Math.PI) * radius * 0.86, Math.sin(angle + Math.PI) * radius * 0.86, 0.01 * s))
  for (const at of holes) {
    const dot = k.mesh(new CylinderGeometry(0.0058 * s, 0.0058 * s, 0.006 * s, 10), hole)
    dot.rotation.x = Math.PI / 2
    dot.position.copy(at)
    button.add(dot)
  }
  button.position.copy(centre)
  button.quaternion.copy(facing(normal, 0.3))
  group.add(button)
  // The thread: through a hole, down past the cheek, tied off on the scarf.
  const from = holes[1].clone().applyQuaternion(button.quaternion).add(centre)
  const below = from.clone().add(new Vector3(0.03 * s, -0.25 * s, 0))
  const scarf = hit([b.scarf], below.clone().addScaledVector(front, 0.6), b.axis(below))
  const to = scarf ? scarf.point.addScaledVector(scarf.normal, 0.004 * s) : from.clone().add(new Vector3(0.03 * s, -0.16 * s, 0))
  const sag = from.clone().lerp(to, 0.5).addScaledVector(front, 0.04 * s).add(new Vector3(0.025 * s, -0.02 * s, 0))
  const thread = k.standard(THREAD, 0.7)
  group.add(k.mesh(new TubeGeometry(new CatmullRomCurve3([from, sag, to]), 32, 0.0026 * s, 6, false), thread))
  const knot = k.mesh(new SphereGeometry(0.0075 * s, 10, 8), thread)
  knot.position.copy(to)
  group.add(knot)
  return group
}

/** Tailor's chalk tucked behind the left "ear", like a pencil, and the cut line it drew on the tummy. */
function chalk(k: Kit, b: Body): Object3D {
  const s = b.scale
  const front = new Vector3(0, 0, 1).applyQuaternion(b.turn)
  const side = new Vector3(1, 0, 0).applyQuaternion(b.turn)
  const group = new Group()
  group.name = 'wear_chalk'
  const meshes = shown(b.head)
  const box = new Box3()
  for (const mesh of meshes) box.expandByObject(mesh)
  const eye = b.eye.getWorldPosition(new Vector3())
  if (!box.isEmpty()) {
    const middle = box.getCenter(new Vector3()).setY(eye.y + 0.045 * s)
    const from = middle.clone().addScaledVector(side, -0.6 * s).addScaledVector(front, 0.08 * s)
    const ear = hit(meshes, from, middle)
    if (ear) {
      // A flat rounded triangle, standing up behind the ear, leaning back a little.
      const piece = k.mesh(new CylinderGeometry(0.06 * s, 0.06 * s, 0.016 * s, 3, 1), k.own(new MeshStandardMaterial({ color: '#E4DAF5', roughness: 0.95 })))
      // Its flat face turned mostly toward the viewer, so it reads at a glance; a corner tucked in.
      const out = ear.normal.clone().lerp(front, 0.55).normalize()
      piece.position.copy(ear.point).addScaledVector(ear.normal, -0.006 * s).add(new Vector3(0, 0.022 * s, 0))
      piece.quaternion.copy(facing(out, 0.35)).multiply(new Quaternion().setFromEuler(new Euler(Math.PI / 2, Math.PI / 6, 0)))
      group.add(piece)
    }
  }
  // The cut line, drawn in chalk across the tummy.
  const lineAt = b.at(-0.04, 0.055, 0.3)
  const tummy = hit([b.torso], lineAt.clone().addScaledVector(front, 0.4), b.axis(lineAt))
  if (tummy) {
    const material = k.own(new MeshStandardMaterial({ map: chalkLineTexture(k), transparent: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: -4, depthWrite: false }))
    const line = k.mesh(new DecalGeometry(b.torso, tummy.point, new Euler().setFromQuaternion(facing(tummy.normal, -0.1)), new Vector3(0.2 * s, 0.05 * s, 0.12 * s)), material)
    line.castShadow = false
    group.add(line)
  }
  return group
}

/** A gingham patch sewn onto the tummy, following its curve. */
function patch(k: Kit, b: Body): Object3D {
  const s = b.scale
  const front = new Vector3(0, 0, 1).applyQuaternion(b.turn)
  const group = new Group()
  group.name = 'wear_patch'
  const spot = b.at(0.085, 0.1, 0.3)
  const tummy = hit([b.torso], spot.clone().addScaledVector(front, 0.4), b.axis(spot))
  if (!tummy) return group
  const material = k.own(new MeshStandardMaterial({ map: patchTexture(k), transparent: true, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -4, depthWrite: false }))
  const cloth = k.mesh(new DecalGeometry(b.torso, tummy.point, new Euler().setFromQuaternion(facing(tummy.normal, 0.16)), new Vector3(0.1 * s, 0.1 * s, 0.1 * s)), material)
  cloth.castShadow = false
  group.add(cloth)
  return group
}

/** A safety pin fastening the scarf at the front, like a brooch. */
function pin(k: Kit, b: Body): Object3D {
  const s = b.scale
  const front = new Vector3(0, 0, 1).applyQuaternion(b.turn)
  const group = new Group()
  group.name = 'wear_pin'
  const centre = b.at(-0.055, 0.318, 0.2)
  const surface = hit([b.scarf], centre.clone().addScaledVector(front, 0.4), b.axis(centre))
  const normal = surface?.normal ?? front
  const length = 0.072 * s
  const wire = 0.0028 * s
  // Drawn flat: the coil at one end, the clasp at the other, the bar dipping into the cloth.
  const shank = new CatmullRomCurve3([new Vector3(-length / 2, -0.007 * s, 0.001 * s), new Vector3(length / 2 - 0.01 * s, -0.007 * s, 0.001 * s)])
  const bar = new CatmullRomCurve3([
    new Vector3(-length / 2, 0.005 * s, 0.001 * s), new Vector3(-length / 5, 0.007 * s, -0.007 * s), new Vector3(length / 5, 0.007 * s, -0.007 * s), new Vector3(length / 2 - 0.012 * s, 0.006 * s, 0.001 * s),
  ])
  const shape = new Group()
  shape.add(k.mesh(new TubeGeometry(shank, 16, wire, 6, false), k.steel))
  shape.add(k.mesh(new TubeGeometry(bar, 24, wire, 6, false), k.steel))
  const coil = k.mesh(new TorusGeometry(0.0068 * s, wire, 6, 16), k.steel)
  coil.position.x = -length / 2 - 0.004 * s
  coil.rotation.y = Math.PI / 2
  const clasp = k.mesh(new SphereGeometry(0.009 * s, 12, 8), k.standard('#DADDE2', 0.25, 0.95))
  clasp.scale.set(1.6, 1.15, 0.55)
  clasp.position.x = length / 2 - 0.006 * s
  shape.add(coil, clasp)
  shape.position.copy(surface?.point ?? centre).addScaledVector(normal, 0.003 * s)
  shape.quaternion.copy(facing(normal, -0.18))
  group.add(shape)
  return group
}

/** A pincushion strapped round the wrist, three pins in it. In the hand's own space. */
function cushion(k: Kit, b: Body): Object3D {
  const group = new Group()
  group.name = 'wear_cushion'
  const strap = k.mesh(new TorusGeometry(0.05, 0.012, 10, 36), k.standard('#4F6A4A', 0.85))
  strap.rotation.x = Math.PI / 2
  const velvet = k.own(new MeshPhysicalMaterial({ color: '#86A880', roughness: 0.9, sheen: 1, sheenRoughness: 0.5, sheenColor: new Color('#DDEBD8') }))
  const dome = k.mesh(new SphereGeometry(0.054, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.55), velvet)
  dome.scale.set(1, 0.7, 1)
  // Six tufts where it is quilted, like a tomato pincushion.
  const tufts = new Group()
  for (let i = 0; i < 6; i += 1) {
    const tuft = k.mesh(new SphereGeometry(0.0045, 8, 6), k.standard('#4F6A4A', 0.8))
    const angle = (i / 6) * Math.PI * 2
    tuft.position.set(Math.cos(angle) * 0.03, 0.026, Math.sin(angle) * 0.03)
    tufts.add(tuft)
  }
  // On the outside of the wrist, away from the body and a little to the front.
  const outward = new Vector3(-0.38, 0.22, 0.9).normalize()
  const seat = new Group()
  seat.position.copy(outward).multiplyScalar(0.058)
  seat.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), outward)
  seat.add(dome, tufts)
  for (const [index, color] of [PEARL, '#F4F1EA', THREAD].entries()) {
    const angle = -0.55 + index * 0.55
    const stem = k.mesh(new CylinderGeometry(0.0022, 0.0022, 0.05, 6), k.steel)
    stem.position.set(Math.sin(angle) * 0.02, 0.048, (index - 1) * 0.008)
    stem.rotation.set((index - 1) * 0.2, 0, -angle * 0.7)
    const head = k.mesh(new SphereGeometry(0.0085, 12, 10), k.standard(color, 0.35))
    head.position.y = 0.026
    stem.add(head)
    seat.add(stem)
  }
  group.add(strap, seat)
  // The wrist: the arm just above the mitten.
  group.position.set(0, 0.075, 0)
  b.hand.add(group)
  return group
}

/**
 * A weaver's shuttle pushed through the top of the head at a jaunty angle, the way needles are
 * stuck in a ball of yarn, its thread drifting down the side. On the head it shows in every pose:
 * the hands are tucked away in the stills and busy typing on the bench.
 */
function shuttle(k: Kit, b: Body): Object3D {
  const s = b.scale
  const group = new Group()
  group.name = 'wear_shuttle'
  const meshes = shown(b.head)
  const box = new Box3()
  for (const mesh of meshes) box.expandByObject(mesh)
  if (box.isEmpty()) return group
  const middle = box.getCenter(new Vector3())
  const size = box.getSize(new Vector3())
  const side = new Vector3(1, 0, 0).applyQuaternion(b.turn)
  const front = new Vector3(0, 0, 1).applyQuaternion(b.turn)
  // In from above, off to the viewer's right and a little in front of the middle.
  const aim = middle.clone().addScaledVector(side, size.x * 0.18).add(new Vector3(0, size.y * 0.28, 0)).addScaledVector(front, size.z * 0.05)
  const from = aim.clone().addScaledVector(side, 0.35 * s).add(new Vector3(0, 0.45 * s, 0)).addScaledVector(front, 0.12 * s)
  const entry = hit(meshes, from, aim)
  if (!entry) return group
  const into = aim.clone().sub(from).normalize()
  // A boat: a pointed lathe, flattened, with the bobbin showing in its hollow.
  const profile = [[0, -0.09], [0.012, -0.075], [0.024, -0.045], [0.03, 0], [0.024, 0.045], [0.012, 0.075], [0, 0.09]].map(([r, y]) => new Vector2(r * s, y * s))
  const hull = k.mesh(new LatheGeometry(profile, 24), k.own(new MeshPhysicalMaterial({ color: '#C79D6E', roughness: 0.45, clearcoat: 0.6, clearcoatRoughness: 0.3 })))
  hull.scale.set(1, 1, 0.62)
  const hollow = k.mesh(new SphereGeometry(0.018 * s, 16, 10), k.standard('#5C4330', 0.8))
  hollow.scale.set(0.75, 2.4, 0.5)
  hollow.position.z = 0.013 * s
  const bobbin = k.mesh(new CylinderGeometry(0.0085 * s, 0.0085 * s, 0.05 * s, 16), k.standard('#B9A9E6', 0.75))
  bobbin.position.z = 0.016 * s
  const boat = new Group()
  boat.add(hull, hollow, bobbin)
  // Its lower point buried a third of the way in, its hollow turned toward the viewer.
  boat.quaternion.setFromUnitVectors(new Vector3(0, -1, 0), into)
  const facingViewer = new Vector3(0, 0, 1).applyQuaternion(boat.quaternion)
  const toViewer = front.clone().projectOnPlane(into).normalize()
  const angle = Math.atan2(new Vector3().crossVectors(facingViewer, toViewer).dot(into.clone().negate()), facingViewer.dot(toViewer))
  boat.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -angle))
  boat.position.copy(entry.point).addScaledVector(into, -0.03 * s)
  group.add(boat)
  // The thread, from the shuttle's top end, out and down beside the head to the shoulder.
  group.updateMatrixWorld(true)
  const top = hull.localToWorld(new Vector3(0, 0.088 * s, 0))
  // A short loose end: out past the side of the head, then hanging, as thread does.
  const points = [
    top,
    top.clone().addScaledVector(side, 0.035 * s).add(new Vector3(0, 0.012 * s, 0)),
    top.clone().addScaledVector(side, 0.06 * s).add(new Vector3(0, -0.04 * s, 0)).addScaledVector(front, 0.01 * s),
    top.clone().addScaledVector(side, 0.055 * s).add(new Vector3(0, -0.13 * s, 0)).addScaledVector(front, 0.02 * s),
  ]
  const line = k.mesh(new TubeGeometry(new CatmullRomCurve3(points, false, 'centripetal'), 48, 0.0024 * s, 6, false), k.standard('#9C8BD6', 0.75))
  line.castShadow = false
  group.add(line)
  return group
}

/**
 * Put on what `wear` names, fitted to `figure` (the model's `figure` node) wearing head `kind`.
 * Returns how to take it all off again.
 */
export function dress(figure: Object3D, kind: string, wear: readonly Accessory[], options: DressOptions = {}): Dressed {
  const k = kit()
  const placed: Object3D[] = []
  const b = bodyOf(figure, kind)
  if (b) {
    const nudge = options.faceNudge ?? new Vector3()
    // Built in world space, then handed to the part it hangs from, so it moves with it.
    const hang = (parent: Object3D, object: Object3D) => { parent.attach(object); placed.push(object) }
    for (const item of wear) {
      switch (item) {
        case 'band': hang(b.body, tape(k, b)); break
        case 'monocle': hang(b.head, monocle(k, b, nudge)); break
        case 'chalk': hang(b.body, chalk(k, b)); break
        case 'patch': hang(b.body, patch(k, b)); break
        case 'pin': hang(b.body, pin(k, b)); break
        case 'cushion': placed.push(cushion(k, b)); break
        case 'shuttle': hang(b.head, shuttle(k, b)); break
      }
    }
  }
  return {
    undress: () => {
      for (const object of placed) object.removeFromParent()
      for (const item of k.made) item.dispose()
    },
  }
}
