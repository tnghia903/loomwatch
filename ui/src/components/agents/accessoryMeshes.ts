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
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

import type { Accessory } from '../../lib/quests/catalog'

/**
 * The wardrobe (lib/quests/catalog.ts), worn the way a tailor wears it and fitted to the figure's
 * own model. The clothes are cloth laid over the body, one set at a time: a plain tee in a deeper
 * shade of the figure's own colour, denim work overalls, a linen maker's apron with leather straps,
 * or a charcoal crew vest. The accessories go over them: the tape measure lies over the shoulders and hangs down the chest, the
 * monocle is a button with a lens in it, tied to the chest with plum thread, the chalk is tucked
 * behind an ear and has drawn a cut line on the tummy, the patch is sewn onto the tummy's curve, a
 * safety pin is worn on the chest, the pincushion is strapped round a wrist and a shuttle is pushed
 * through the top of the head, as needles are stuck in a ball of yarn. Each is placed by casting
 * rays onto the body, or onto the clothes when it wears some, so it sits on the surface of
 * whichever figure wears it.
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
function hit(targets: Mesh[], from: Vector3, to: Vector3): { point: Vector3; normal: Vector3; mesh: Mesh } | null {
  const direction = to.clone().sub(from).normalize()
  ray.set(from, direction)
  ray.far = from.distanceTo(to) * 2
  const found = ray.intersectObjects(targets, false)[0]
  if (!found?.face) return null
  const normal = found.face.normal.clone().transformDirection(found.object.matrixWorld)
  if (normal.dot(direction) > 0) normal.negate()
  return { point: found.point.clone(), normal, mesh: found.object as Mesh }
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
  /** The clothes it has on, once put on: what goes over them lies on them. */
  clothes: Mesh[]
  /** Both arms, at the shoulder: sleeves hang from them. */
  arms: Object3D[]
  /** The colour of its skin, which a tee is a deeper shade of. */
  skin: Color
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

/** What lies outermost on the body: its clothes, then the torso under them. */
const over = (b: Body): Mesh[] => [...b.clothes, b.torso]

function bodyOf(figure: Object3D, kind: string): Body | null {
  const names = ['body', 'head', 'torso', `${kind}_eye_r`, 'hand_r', 'arm_l', 'arm_r']
  const nodes = names.map((name) => figure.getObjectByName(name))
  if (nodes.some((node) => !node)) return null
  const [body, head, torso, eye, hand, armL, armR] = nodes as Object3D[]
  const skin = ((torso as Mesh).material as MeshStandardMaterial).color?.clone() ?? new Color('#E3A386')
  figure.updateWorldMatrix(true, true)
  const base = body.getWorldPosition(new Vector3())
  const scale = figure.getWorldScale(new Vector3()).x
  const turn = figure.getWorldQuaternion(new Quaternion())
  return {
    figure, body, head, torso: torso as Mesh, clothes: [], arms: [armL, armR], skin, eye, hand, scale, turn, base,
    at: (x, y, z) => new Vector3(x, y, z).applyQuaternion(turn).multiplyScalar(scale).add(base),
    axis: (point) => new Vector3(base.x, point.y, base.z),
  }
}

// ── The clothes ────────────────────────────────────────────────────────────────────────────────
// Cloth is a thin shell over the torso: at each angle round the body (0 at the front, toward the
// figure's left as it grows) and each height up from its seat, a ray finds the torso's surface and
// the cloth sits a little off it. So it hugs whichever body wears it, and its arms hang over it.

const smoothstep = (from: number, to: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)))
  return t * t * (3 - 2 * t)
}

/** The torso's surface at angle `a` and height `h` (the figure's own units), in world space. */
function onTorso(b: Body, a: number, h: number): { point: Vector3; normal: Vector3 } {
  const centre = b.at(0, h, 0)
  const outside = b.at(Math.sin(a) * 0.6, h, Math.cos(a) * 0.6)
  const found = hit([b.torso], outside, centre)
  return found ?? { point: b.at(Math.sin(a) * 0.2, h, Math.cos(a) * 0.2), normal: outside.clone().sub(centre).normalize() }
}

/** A point on the torso at (a, h), lifted `lift` off it, and the surface's normal there. */
function lifted(b: Body, a: number, h: number, lift: number): { point: Vector3; normal: Vector3 } {
  const { point, normal } = onTorso(b, a, h)
  return { point: point.addScaledVector(normal, lift * b.scale), normal }
}

interface ClothSpec {
  /** From angle a0 round to a1; a whole turn closes behind. */
  a0: number
  a1: number
  /** Its lower and upper edge at each angle. */
  low: (a: number) => number
  high: (a: number) => number
  /** How far off the body it sits, at angle `a` and `t` of the way up (0 at its lower edge). */
  lift: (a: number, t: number) => number
  thick: number
  columns?: number
  rows?: number
}

/** A piece of cloth: its outer face, its inner face and its edges, closed. */
function cloth(b: Body, spec: ClothSpec): BufferGeometry {
  const { a0, a1, low, high, lift, thick, columns = 72, rows = 12 } = spec
  const whole = Math.abs(a1 - a0 - Math.PI * 2) < 1e-6
  const positions: number[] = []
  const at = (layer: number, i: number, j: number) => layer * (columns + 1) * (rows + 1) + i * (rows + 1) + j
  for (const layer of [0, 1]) {
    for (let i = 0; i <= columns; i += 1) {
      const a = a0 + ((a1 - a0) * i) / columns
      const from = low(a)
      const to = Math.max(high(a), from + 0.002)
      for (let j = 0; j <= rows; j += 1) {
        const t = j / rows
        const { point } = lifted(b, a, from + (to - from) * t, lift(a, t) + (layer === 0 ? thick : 0))
        positions.push(point.x, point.y, point.z)
      }
    }
  }
  const indices: number[] = []
  const quad = (p: number, q: number, r: number, u: number) => indices.push(p, q, r, p, r, u)
  for (let i = 0; i < columns; i += 1) {
    for (let j = 0; j < rows; j += 1) {
      quad(at(0, i, j), at(0, i + 1, j), at(0, i + 1, j + 1), at(0, i, j + 1))
      quad(at(1, i, j), at(1, i, j + 1), at(1, i + 1, j + 1), at(1, i + 1, j))
    }
    // The lower and upper edges.
    quad(at(1, i, 0), at(1, i + 1, 0), at(0, i + 1, 0), at(0, i, 0))
    quad(at(0, i, rows), at(0, i + 1, rows), at(1, i + 1, rows), at(1, i, rows))
  }
  if (!whole) {
    for (let j = 0; j < rows; j += 1) {
      quad(at(0, 0, j), at(0, 0, j + 1), at(1, 0, j + 1), at(1, 0, j))
      quad(at(1, columns, j), at(1, columns, j + 1), at(0, columns, j + 1), at(0, columns, j))
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

/** A running stitch: short dashes along a path of (a, h) laid `lift` off the torso. */
function stitches(k: Kit, b: Body, path: [number, number][], lift: number, material: Material): Mesh | null {
  const s = b.scale
  const points = path.map(([a, h]) => lifted(b, a, h, lift).point)
  const pieces: BufferGeometry[] = []
  const dash = 0.012 * s
  const gap = 0.009 * s
  let run = 0
  let on = true
  let start = points[0]
  for (let i = 1; i < points.length; i += 1) {
    run += points[i].distanceTo(points[i - 1])
    if (on && run >= dash) {
      const along = points[i].clone().sub(start)
      const piece = new CylinderGeometry(0.0032 * s, 0.0032 * s, along.length(), 5, 1)
      piece.applyMatrix4(new Matrix4().compose(start.clone().lerp(points[i], 0.5), new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), along.normalize()), new Vector3(1, 1, 1)))
      pieces.push(piece)
      on = false
      run = 0
    } else if (!on && run >= gap) {
      on = true
      run = 0
      start = points[i]
    }
  }
  if (pieces.length === 0) return null
  const merged = mergeGeometries(pieces)
  for (const piece of pieces) piece.dispose()
  return merged ? k.mesh(merged, material) : null
}

/** Points along a polyline of (a, h), `count` of them, evenly spaced along it. */
function along(path: [number, number][], count: number): [number, number][] {
  const lengths = path.slice(1).map(([a, h], i) => Math.hypot((a - path[i][0]) * 0.18, h - path[i][1]))
  const total = lengths.reduce((sum, length) => sum + length, 0)
  const out: [number, number][] = []
  for (let n = 0; n <= count; n += 1) {
    let d = (total * n) / count
    for (const [i, length] of lengths.entries()) {
      if (d <= length || i === lengths.length - 1) {
        const t = length ? Math.min(1, d / length) : 0
        out.push([path[i][0] + (path[i + 1][0] - path[i][0]) * t, path[i][1] + (path[i + 1][1] - path[i][1]) * t])
        break
      }
      d -= length
    }
  }
  return out
}

/** A flat strap along a path of (a, h), `width` across, lying `lift` off the torso. */
function strap(k: Kit, b: Body, path: [number, number][], width: number, lift: number, material: Material): Mesh {
  const laid = along(path, 40).map(([a, h]) => lifted(b, a, h, lift))
  return k.mesh(ribbon(laid.map(({ point }) => point), laid.map(({ normal }) => normal), width * b.scale, 80), material)
}

/** A small round button sewn flat onto the cloth at (a, h). */
function stud(k: Kit, b: Body, a: number, h: number, lift: number, radius: number, material: Material): Mesh {
  const { point, normal } = lifted(b, a, h, lift)
  const button = k.mesh(new SphereGeometry(radius * b.scale, 16, 10), material)
  button.scale.set(1, 1, 0.42)
  button.position.copy(point)
  button.quaternion.copy(facing(normal))
  return button
}

/** All the way round. */
const ROUND = { a0: -Math.PI, a1: Math.PI }

/** A plain tee in a deeper shade of its own colour, with short sleeves on both arms: the sleeves
    hang from the arms, so they come back too. */
function tee(k: Kit, b: Body): { body: Object3D; sleeves: Object3D[] } {
  const group = new Group()
  group.name = 'wear_tee'
  const cotton = k.own(new MeshStandardMaterial({ color: b.skin.clone().multiplyScalar(0.72), roughness: 0.85 }))
  const body = k.mesh(cloth(b, { ...ROUND, low: () => 0.004, high: () => 0.329, lift: () => 0.006, thick: 0.006, rows: 16 }), cotton)
  group.add(body)
  b.clothes.push(body)
  const sleeves = b.arms.map((arm) => {
    // In the arm's own space, so the sleeve swings with it: the arm hangs down from the shoulder.
    // The arm is slim at the shoulder and fuller toward the mitten, so the sleeve widens with it.
    const sleeve = k.mesh(new CylinderGeometry(0.036, 0.044, 0.08, 24, 1, true), cotton)
    sleeve.position.y = -0.03
    const hem = k.mesh(new TorusGeometry(0.044, 0.005, 6, 24), cotton)
    hem.rotation.x = Math.PI / 2
    hem.position.y = -0.07
    const cuff = new Group()
    cuff.name = 'wear_tee_sleeve'
    cuff.add(sleeve, hem)
    arm.add(cuff)
    return cuff
  })
  return { body: group, sleeves }
}

const DENIM = '#5E719B'

/** Denim work overalls: the legs round the seat, a bib with a pocket, straps over the shoulders,
    nickel buttons and cream topstitching (gold is you, so none of it is gold). */
function overalls(k: Kit, b: Body): Object3D {
  const group = new Group()
  group.name = 'wear_overalls'
  const denim = k.standard(DENIM, 0.86)
  const deep = k.standard('#506288', 0.88)
  const nickel = k.steel
  const thread = k.standard('#EFE6D3', 0.7)
  const bibTop = (a: number) => 0.262 - (Math.abs(a) > 0.4 ? 0.03 * (1 - Math.sqrt(Math.max(0, 1 - ((Math.abs(a) - 0.4) / 0.14) ** 2))) : 0)
  const legs = k.mesh(cloth(b, { ...ROUND, low: () => 0.004, high: () => 0.15, lift: () => 0.006, thick: 0.007 }), denim)
  const bib = k.mesh(cloth(b, { a0: -0.54, a1: 0.54, low: () => 0.14, high: bibTop, lift: () => 0.007, thick: 0.007, columns: 32 }), denim)
  const pocket = k.mesh(cloth(b, { a0: -0.2, a1: 0.2, low: () => 0.168, high: () => 0.226, lift: () => 0.0135, thick: 0.005, columns: 12, rows: 4 }), deep)
  group.add(legs, bib, pocket)
  b.clothes.push(legs, bib)
  const seams = [
    stitches(k, b, along([[-0.18, 0.219], [0.18, 0.219]], 60), 0.0185, thread),
    stitches(k, b, along([[-Math.PI, 0.142], [-0.56, 0.142]], 120), 0.0135, thread),
    stitches(k, b, along([[0.56, 0.142], [Math.PI, 0.142]], 120), 0.0135, thread),
  ]
  for (const seam of seams) if (seam) group.add(seam)
  for (const side of [-1, 1]) {
    group.add(strap(k, b, [[side * 0.42, 0.25], [side * 0.5, 0.29], [side * 0.75, 0.318], [side * 1.6, 0.322], [side * 2.4, 0.27], [side * 2.7, 0.15]], 0.042, 0.011, denim))
    group.add(stud(k, b, side * 0.42, 0.247, 0.018, 0.017, nickel))
  }
  return group
}

/** A linen maker's apron on leather straps with copper rivets, sewn in the plum thread, a wooden
    pencil in its pocket. */
function apron(k: Kit, b: Body): Object3D {
  const s = b.scale
  const group = new Group()
  group.name = 'wear_apron'
  const linen = k.standard('#E9DDC6', 0.88)
  const leather = k.standard('#8A5A3C', 0.6)
  const copper = k.standard('#A86A4A', 0.35, 0.8)
  const thread = k.standard(THREAD, 0.7)
  const top = (a: number) => (Math.abs(a) < 0.4 ? 0.282 : 0.282 - (0.282 - 0.168) * smoothstep(0.4, 0.62, Math.abs(a)))
  const low = (a: number) => 0.035 + 0.03 * smoothstep(0.62, 0.9, Math.abs(a))
  const front = k.mesh(cloth(b, { a0: -0.9, a1: 0.9, low, high: top, lift: (_a, t) => 0.008 + 0.004 * (1 - t), thick: 0.007, columns: 48, rows: 16 }), linen)
  const pocket = k.mesh(cloth(b, { a0: -0.3, a1: 0.3, low: () => 0.07, high: () => 0.135, lift: () => 0.0175, thick: 0.006, columns: 16, rows: 4 }), linen)
  group.add(front, pocket)
  b.clothes.push(front)
  const seams = [
    stitches(k, b, along([[-0.28, 0.128], [0.28, 0.128]], 80), 0.0235, thread),
    stitches(k, b, along(Array.from({ length: 25 }, (_, i) => { const a = -0.86 + (1.72 * i) / 24; return [a, low(a) + 0.012] as [number, number] }), 160), 0.0155, thread),
  ]
  for (const seam of seams) if (seam) group.add(seam)
  for (const side of [-1, 1]) {
    group.add(strap(k, b, [[side * 0.33, 0.27], [side * 0.5, 0.305], [side * 1.1, 0.322], [side * 2.0, 0.325], [side * Math.PI, 0.326]], 0.024, 0.016, leather))
    group.add(strap(k, b, [[side * 0.86, 0.16], [side * 1.6, 0.165], [side * Math.PI, 0.17]], 0.022, 0.012, leather))
    group.add(stud(k, b, side * 0.33, 0.268, 0.019, 0.011, copper))
  }
  // A pencil in the pocket, leaning.
  const { point, normal } = lifted(b, 0.14, 0.12, 0.03)
  const pencil = new Group()
  const wood = k.mesh(new CylinderGeometry(0.009 * s, 0.009 * s, 0.09 * s, 6), k.standard('#C79D6E', 0.5))
  const tip = k.mesh(new CylinderGeometry(0, 0.009 * s, 0.018 * s, 6), k.standard('#E9D5B1', 0.6))
  tip.position.y = 0.054 * s
  pencil.add(wood, tip)
  pencil.position.copy(point)
  pencil.quaternion.copy(facing(normal)).multiply(new Quaternion().setFromEuler(new Euler(-Math.PI / 2 + 0.12, 0, -0.24)))
  group.add(pencil)
  return group
}

/** A charcoal crew vest, open down the front in a V, two pockets and horn buttons. */
function vest(k: Kit, b: Body): Object3D {
  const group = new Group()
  group.name = 'wear_vest'
  const wool = k.standard('#3F3F49', 0.86)
  const deep = k.standard('#35353E', 0.88)
  const horn = k.standard('#5C4330', 0.4)
  const thread = k.standard('#EFE6D3', 0.7)
  const top = (a: number) => 0.17 + (0.318 - 0.17) * smoothstep(0.06, 0.55, Math.abs(a))
  for (const [a0, a1] of [[0.07, Math.PI], [-Math.PI, -0.07]]) {
    const half = k.mesh(cloth(b, { a0, a1, low: () => 0.045, high: top, lift: () => 0.008, thick: 0.008, columns: 56, rows: 14 }), wool)
    group.add(half)
    b.clothes.push(half)
  }
  for (const side of [-1, 1]) {
    group.add(k.mesh(cloth(b, { a0: side * 0.62 - 0.17, a1: side * 0.62 + 0.17, low: () => 0.085, high: () => 0.135, lift: () => 0.0145, thick: 0.005, columns: 10, rows: 4 }), deep))
    const seams = [
      stitches(k, b, along([[side * 0.62 - 0.15, 0.129], [side * 0.62 + 0.15, 0.129]], 40), 0.0185, thread),
      stitches(k, b, along(Array.from({ length: 21 }, (_, i) => { const h = 0.06 + (0.25 * i) / 20; return [side * (0.1 + 0.42 * smoothstep(0.17, 0.31, h)), h] as [number, number] }), 120), 0.0175, thread),
    ]
    for (const seam of seams) if (seam) group.add(seam)
  }
  for (const h of [0.1, 0.15]) group.add(stud(k, b, -0.13, h, 0.017, 0.011, horn))
  return group
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
  const { points, normals } = drape(path, over(b), (point) => b.axis(point).add(new Vector3(0, -0.12 * s, 0)), 0.005 * s)
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

/** A lens set in a big four-hole button, on the eye, tied to the chest with plum thread. */
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
  // The thread: through a hole, down past the cheek, tied off on the chest.
  const from = holes[1].clone().applyQuaternion(button.quaternion).add(centre)
  const below = from.clone().add(new Vector3(0.03 * s, -0.25 * s, 0))
  const chest = hit(over(b), below.clone().addScaledVector(front, 0.6), b.axis(below))
  const to = chest ? chest.point.addScaledVector(chest.normal, 0.004 * s) : from.clone().add(new Vector3(0.03 * s, -0.16 * s, 0))
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
  const tummy = hit(over(b), lineAt.clone().addScaledVector(front, 0.4), b.axis(lineAt))
  if (tummy) {
    const material = k.own(new MeshStandardMaterial({ map: chalkLineTexture(k), transparent: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: -4, depthWrite: false }))
    const line = k.mesh(new DecalGeometry(tummy.mesh, tummy.point, new Euler().setFromQuaternion(facing(tummy.normal, -0.1)), new Vector3(0.2 * s, 0.05 * s, 0.12 * s)), material)
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
  const tummy = hit(over(b), spot.clone().addScaledVector(front, 0.4), b.axis(spot))
  if (!tummy) return group
  const material = k.own(new MeshStandardMaterial({ map: patchTexture(k), transparent: true, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -4, depthWrite: false }))
  const cloth = k.mesh(new DecalGeometry(tummy.mesh, tummy.point, new Euler().setFromQuaternion(facing(tummy.normal, 0.16)), new Vector3(0.1 * s, 0.1 * s, 0.1 * s)), material)
  cloth.castShadow = false
  group.add(cloth)
  return group
}

/** A safety pin worn on the chest, like a brooch. */
function pin(k: Kit, b: Body): Object3D {
  const s = b.scale
  const front = new Vector3(0, 0, 1).applyQuaternion(b.turn)
  const group = new Group()
  group.name = 'wear_pin'
  const centre = b.at(-0.045, 0.25, 0.2)
  const surface = hit(over(b), centre.clone().addScaledVector(front, 0.4), b.axis(centre))
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
        case 'tee': { const { body, sleeves } = tee(k, b); hang(b.body, body); placed.push(...sleeves); break }
        case 'overalls': hang(b.body, overalls(k, b)); break
        case 'apron': hang(b.body, apron(k, b)); break
        case 'vest': hang(b.body, vest(k, b)); break
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
