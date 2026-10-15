import {
  Box3,
  BoxGeometry,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NeutralToneMapping,
  Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  PMREMGenerator,
  PointLight,
  Quaternion,
  Raycaster,
  Scene,
  ShadowMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
  type Texture,
} from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

import { CARD_SLOTS, FIGURE_KEYS, partOfNode, reactionsBetween, type FigureLook, type FigureMood, type FigurePart, type FigureReaction } from '../../lib/library/figure'
import { COLOR_HEX, FIGURE_KINDS, type FigureChoice, type FigureKind } from '../../lib/library/figures'
import type { AllowSwitch } from '../../lib/team-file/types'
import { cardTexture, keyLabelTexture, pegboardTexture, swatchTextures, woundTexture } from './benchTextures'

/** Everything the bench shows, from the agent on screen and the test bench's run. */
export interface BenchView {
  look: FigureLook
  /** The figure it wears: which head, and the colour of its skin. */
  figure: FigureChoice
  /** The agent's woven mark (markPattern), woven into its scarf. */
  pattern: readonly boolean[]
  does: string
  appName: string
  hasReply: boolean
  mood: FigureMood
  /** Recorded events in the run so far: each one flickers its screen. */
  events: number
  asked: AllowSwitch | null
  open: FigurePart | null
  /** A skill card is being dragged over the bench. */
  dropping: boolean
}

export type BenchAnchor = 'mind' | 'app' | 'name' | 'job' | 'skills' | 'keys' | 'dish' | 'reply'
export type BenchAnchors = Record<BenchAnchor, { x: number; y: number }>
/** The faces that carry words: the nameplate, the job sheet and the laptop's lid. */
export type BenchFace = 'name' | 'job' | 'app'
/** Where a face is on screen: its top left corner, and its top and left edges from there. */
export interface BenchQuad { x: number; y: number; ux: number; uy: number; vx: number; vy: number }
export type BenchFaces = Record<BenchFace, BenchQuad>

/**
 * Lay page text over one of the worded faces, each frame: the scene leaves the face plain, because
 * painted words blur once the bench is drawn small. The element is laid out at the size the face
 * has on screen, so its words are drawn at their own size and stay sharp; a face seen square on
 * only moves, it doesn't turn or lean. Used by the app's bench (AgentFigure) and the landing page's.
 */
export function placeFace(element: HTMLElement, { x, y, ux, uy, vx, vy }: BenchQuad) {
  const across = Math.hypot(ux, uy)
  const down = Math.hypot(vx, vy)
  if (across < 1 || down < 1) return
  const [a, b, c, d] = [ux / across, uy / across, vx / down, vy / down]
  const transform = Math.abs(b) < 0.02 && Math.abs(c) < 0.02
    ? `translate(${Math.round(x)}px, ${Math.round(y)}px)`
    : `matrix(${a.toFixed(4)}, ${b.toFixed(4)}, ${c.toFixed(4)}, ${d.toFixed(4)}, ${x.toFixed(1)}, ${y.toFixed(1)})`
  const at = `${across.toFixed(1)} ${down.toFixed(1)} ${transform}`
  if (element.dataset.at === at) return
  element.dataset.at = at
  element.style.width = `${across.toFixed(1)}px`
  element.style.height = `${down.toFixed(1)}px`
  element.style.transform = transform
}

export interface BenchCallbacks {
  onPart: (part: FigurePart) => void
  onKey: (key: AllowSwitch, given: boolean) => void
  /** What the pointer is over, for the cursor: a part, or a key it can pick up. */
  onHover: (part: FigurePart | null, grab: boolean) => void
  /** Each frame: where each label and each face goes, in CSS pixels from the canvas's top left. */
  onFrame: (anchors: BenchAnchors, faces: BenchFaces) => void
}

const KEY_NODE: Record<AllowSwitch, string> = { web: 'web', edits: 'files', commands: 'cmd' }
const FACE_MESH: Record<BenchFace, string> = { name: 'nameplate_face', job: 'job_sheet', app: 'laptop_face' }
const DISH_KEY_SCALE = 0.72
const HIGHLIGHT = new Color('#E9C46A')
const LIVE = new Color('#6AB8FF')
/** It looks with its head; its body turns only a little, so both hands stay on the laptop. */
const BODY_TURN = 0.12
/** How far its head turns and nods to look at something. */
const HEAD_TURN = 0.5
const HEAD_NOD = 0.24

/** The figure's pose, as offsets the frame eases toward. Arms at rest reach out to the laptop. */
const REST = { bodyY: 0, bodyRX: 0, bodyRY: 0, neckRX: 0, neckRZ: 0, lookX: 0, lookY: -0.3, armLRX: -1.42, armLRZ: -0.05, armRRX: -1.42, armRRZ: 0.05, scale: 1, band: 0, screen: 0.12, typing: 0, hands: 0 }
type Pose = typeof REST
type Channel = keyof Pose

interface Action { kind: string; start: number; duration: number; side?: number }
interface Tween { node: Object3D; fromP: Vector3; toP: Vector3; fromQ: Quaternion; toQ: Quaternion; fromS: number; toS: number; start: number; duration: number; arc: number; done?: () => void }

const smooth = (edge0: number, edge1: number, x: number) => MathUtils.smoothstep(x, edge0, edge1)
const shown = (object: Object3D | null): boolean => { for (let at = object; at; at = at.parent) if (!at.visible) return false; return true }
const envelope = (u: number) => smooth(0, 0.18, u) * (1 - smooth(0.72, 1, u))
const bump = (u: number) => Math.sin(Math.PI * MathUtils.clamp(u, 0, 1))

/** A flat face's top left, top right and bottom left corners, found by its UVs (glTF's start at the top). */
function corners(mesh: Mesh): Vector3[] {
  const uv = mesh.geometry.getAttribute('uv')
  const position = mesh.geometry.getAttribute('position')
  return [[0, 0], [1, 0], [0, 1]].map(([u, v]) => {
    let best = 0
    for (let index = 1; index < uv.count; index += 1) {
      if (Math.hypot(uv.getX(index) - u, uv.getY(index) - v) < Math.hypot(uv.getX(best) - u, uv.getY(best) - v)) best = index
    }
    return new Vector3().fromBufferAttribute(position, best)
  })
}

/**
 * BUILD BY HAND, live: the agent as a figure at a workbench, doing the work (AgentFigure renders
 * it). The model is Blender's (public/agent/workbench.glb; its script is kept locally, not in git):
 * the bench, and the figure with every head it can wear. This dresses it from the agent's settings
 * and the figure it wears, lets each object on the bench be picked up or clicked, and moves the
 * figure. It moves for two reasons only: a change you just made (it looks at what changed) and the
 * test bench's run record (it types while the record moves, rests its hands while the record is
 * quiet, points at your dish when it waits on you for a key, and hands its reply to the tray when it
 * is done). Nothing else: no pose for a feeling the record doesn't show. Between runs it looks
 * around and blinks. Reduced motion keeps every pose and drops the motion.
 */
export class WorkbenchScene {
  private readonly renderer: WebGLRenderer
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(24, 1, 0.1, 40)
  private readonly callbacks: BenchCallbacks
  private readonly reduced: boolean
  private readonly raycaster = new Raycaster()
  private readonly nodes = new Map<string, Object3D>()
  private readonly roles = new Map<Mesh, string>()
  private readonly pickables: Mesh[] = []
  private readonly disposables: { dispose: () => void }[] = []
  private readonly keyHome = new Map<AllowSwitch, { p: Vector3; q: Quaternion }>()
  /** Where each key lies in your dish: flat, a little smaller, its middle on its spot. */
  private readonly keyDish = new Map<AllowSwitch, Vector3>()
  private readonly cards: { group: Group | null; skill: string | null }[] = Array.from({ length: CARD_SLOTS }, () => ({ group: null, skill: null }))
  private readonly faces = new Map<string, Mesh>()
  /** Each worded face's top left, top right and bottom left corners, in its own space. */
  private readonly faceCorners = new Map<BenchFace, Vector3[]>()
  private readonly parts = new Map<Mesh, FigurePart | null>()
  private flashes = new Map<FigurePart, number>()
  private view: BenchView | null = null
  private loaded = false
  private running = false
  private frameId = 0
  private last = 0
  private width = 1
  private height = 1
  private pointer: Vector2 | null = null
  private hovered: FigurePart | null = null
  private hoveredKey: AllowSwitch | null = null
  private drag: { key: AllowSwitch; x: number; y: number; moved: boolean; plane: Plane } | null = null
  private press: { part: FigurePart | null; x: number; y: number } | null = null
  private actions: Action[] = []
  private tweens: Tween[] = []
  private pose: Pose = { ...REST }
  private nextFidget = 7
  private nextBlink = 2.5
  private now = 0
  private events = 0
  private flicker = 0
  private screenLight: PointLight | null = null
  private moodSince = 0
  private swatch: { map: Texture; bump: Texture } | null = null
  private wound: Texture | null = null
  /** Each head it can wear, and every eye (they blink together; only the worn head's show). */
  private readonly heads = new Map<FigureKind, Object3D>()
  private readonly eyes: Object3D[] = []
  private drawn = { pattern: '', figure: '' }

  constructor(canvas: HTMLCanvasElement, callbacks: BenchCallbacks, reduced: boolean) {
    this.callbacks = callbacks
    this.reduced = reduced
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' })
    this.renderer.setClearColor(0x000000, 0)
    // Neutral keeps the bench's bone, graphite and gold close to the app's own tokens.
    this.renderer.toneMapping = NeutralToneMapping
    this.renderer.toneMappingExposure = 1.0
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = PCFShadowMap

    const pmrem = new PMREMGenerator(this.renderer)
    const room = new RoomEnvironment()
    this.scene.environment = pmrem.fromScene(room, 0.04).texture
    this.scene.environmentIntensity = 0.55
    room.dispose()
    pmrem.dispose()

    this.scene.add(new HemisphereLight('#FFF6E8', '#2A2A32', 0.7))
    const key = new DirectionalLight('#FFF3E2', 2.4)
    key.position.set(-1.1, 4.6, 3.2)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.camera.left = -2.2
    key.shadow.camera.right = 2.2
    key.shadow.camera.top = 2.4
    key.shadow.camera.bottom = -1.2
    key.shadow.camera.near = 0.5
    key.shadow.camera.far = 9
    key.shadow.bias = -0.0004
    key.shadow.normalBias = 0.02
    key.shadow.radius = 3
    key.target.position.set(0, 0.7, -0.3)
    this.scene.add(key, key.target)
    const rim = new DirectionalLight('#DDE6FF', 0.9)
    rim.position.set(2.5, 2.2, -2.5)
    this.scene.add(rim)

    const floorGeometry = new PlaneGeometry(8, 8)
    const floorMaterial = new ShadowMaterial({ opacity: 0.16 })
    const floor = new Mesh(floorGeometry, floorMaterial)
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    this.scene.add(floor)
    this.disposables.push(floorGeometry, floorMaterial)
  }

  async load(url: string): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(url)
    const model = gltf.scene
    this.wound = this.own(woundTexture())
    model.traverse((object) => {
      if (object.name) this.nodes.set(object.name, object)
      if (/_eye_[lr]$/.test(object.name)) this.eyes.push(object)
      if (!(object instanceof Mesh)) return
      const role = (object.material as Material).name
      ;(object.material as Material).dispose()
      object.material = this.material(role, object.name)
      this.roles.set(object, role)
      const flat = object.name.endsWith('_face') || object.name.endsWith('_label') || object.name === 'job_sheet' || object.name === 'laptop_screen'
      object.castShadow = role !== 'glint' && !flat
      object.receiveShadow = role !== 'glint'
      this.pickables.push(object)
      this.disposables.push(object.geometry)
    })
    for (const kind of FIGURE_KINDS) this.heads.set(kind, this.node(`head_${kind}`))
    for (const [face, name] of Object.entries(FACE_MESH) as [BenchFace, string][]) this.faceCorners.set(face, corners(this.node(name) as Mesh))
    this.scene.add(model)
    model.updateMatrixWorld(true)
    for (const { key, node } of FIGURE_KEYS) {
      const found = this.node(`key_${node}`)
      this.keyHome.set(key, { p: found.position.clone(), q: found.quaternion.clone() })
      const middle = found.worldToLocal(new Box3().setFromObject(found).getCenter(new Vector3()))
      this.keyDish.set(key, middle.multiplyScalar(-DISH_KEY_SCALE))
    }
    this.lights()
    this.loaded = true
    this.frame()
    if (this.view) this.apply(null, this.view)
  }

  /** The laptop screen's light on the figure, off until it works. */
  private lights() {
    this.screenLight = new PointLight('#6AB8FF', 0, 1.1, 2)
    this.screenLight.position.set(0, 0.1, -0.12)
    this.node('laptop_lid').add(this.screenLight)
  }

  /** Show the agent and the run as they are now; what changed since last time, it reacts to. */
  set(view: BenchView) {
    const before = this.view
    this.view = view
    if (this.loaded) this.apply(before, view)
  }

  resize(width: number, height: number) {
    const size = fitCanvas(this.renderer, width, height)
    this.width = size.width
    this.height = size.height
    this.camera.aspect = this.width / this.height
    this.fit()
  }

  start() {
    if (this.running) return
    this.running = true
    this.last = performance.now()
    this.frameId = requestAnimationFrame(this.tick)
  }

  stop() {
    this.running = false
    cancelAnimationFrame(this.frameId)
  }

  dispose() {
    this.stop()
    this.scene.traverse((object) => { if (object instanceof Mesh) (object.material as Material).dispose() })
    for (const item of this.disposables) item.dispose()
    this.scene.environment?.dispose()
    this.renderer.dispose()
  }

  // ------------------------------------------------------------------ pointer

  pointerMove(x: number, y: number) {
    this.pointer = new Vector2(x, y)
    if (this.drag) {
      if (!this.drag.moved && Math.hypot(x - this.drag.x, y - this.drag.y) > 5) {
        this.drag.moved = true
        const key = this.node(`key_${KEY_NODE[this.drag.key]}`)
        this.tweens = this.tweens.filter((tween) => tween.node !== key)
        this.scene.attach(key)
      }
      if (this.drag.moved) {
        const hit = new Vector3()
        this.ray(x, y).ray.intersectPlane(this.drag.plane, hit)
        if (hit) this.node(`key_${KEY_NODE[this.drag.key]}`).position.copy(hit)
      }
      return
    }
    const picked = this.pick(x, y)
    this.hovered = picked?.part ?? null
    this.hoveredKey = picked?.key ?? null
    this.callbacks.onHover(this.hovered, Boolean(picked?.key))
  }

  pointerDown(x: number, y: number): boolean {
    const picked = this.pick(x, y)
    if (picked?.key) {
      const key = this.node(`key_${KEY_NODE[picked.key]}`)
      const at = key.getWorldPosition(new Vector3())
      const facing = this.camera.getWorldDirection(new Vector3()).negate()
      this.drag = { key: picked.key, x, y, moved: false, plane: new Plane().setFromNormalAndCoplanarPoint(facing, at) }
      return true
    }
    this.press = { part: picked?.part ?? null, x, y }
    return false
  }

  pointerUp(x: number, y: number) {
    const drag = this.drag
    const press = this.press
    this.drag = null
    this.press = null
    if (drag && this.view) {
      const had = Boolean(this.view.look.allow[drag.key])
      let given = !had
      if (drag.moved) {
        // Dropped nearer its hook than your dish: it goes on the hook.
        const hook = this.screen(this.node(`hook_${KEY_NODE[drag.key]}`).getWorldPosition(new Vector3()))
        const dish = this.screen(this.node('dish').getWorldPosition(new Vector3()))
        given = Math.hypot(x - hook.x, y - hook.y) < Math.hypot(x - dish.x, y - dish.y)
      }
      this.homeKey(drag.key, given)
      if (given !== had) this.callbacks.onKey(drag.key, given)
      return
    }
    if (press && press.part && Math.hypot(x - press.x, y - press.y) < 6) this.callbacks.onPart(press.part)
  }

  pointerLeave() {
    this.pointer = null
    this.hovered = null
    this.hoveredKey = null
    this.callbacks.onHover(null, false)
  }

  // ------------------------------------------------------------------ dressing the bench

  private apply(before: BenchView | null, view: BenchView) {
    const { look } = view
    const pattern = view.pattern.map((on) => (on ? 1 : 0)).join('')
    if (this.drawn.pattern !== pattern) {
      this.drawn.pattern = pattern
      this.swatch?.map.dispose()
      this.swatch?.bump.dispose()
      this.swatch = swatchTextures(view.pattern)
      for (const mesh of this.meshes('scarf')) {
        const material = mesh.material as MeshStandardMaterial
        material.map = this.swatch.map
        material.bumpMap = this.swatch.bump
        material.needsUpdate = true
      }
    }
    const figureKey = `${view.figure.kind}/${view.figure.color}`
    if (this.drawn.figure !== figureKey) {
      this.drawn.figure = figureKey
      this.wear(view.figure)
    }
    for (const { node, word, key } of FIGURE_KEYS) {
      if (!this.faces.has(`key_${node}_label`)) this.paint(`key_${node}_label`, keyLabelTexture(word, key === 'commands'))
    }
    this.node('envelope').visible = view.hasReply || view.mood === 'done'
    this.pinCards(look.skills, before !== null)

    for (const { key } of FIGURE_KEYS) {
      const node = this.node(`key_${KEY_NODE[key]}`)
      const home = this.node(look.allow[key] ? `hook_${KEY_NODE[key]}` : `dish_${KEY_NODE[key]}`)
      if (node.parent !== home && this.drag?.key !== key && !this.tweens.some((tween) => tween.node === node)) this.homeKey(key, Boolean(look.allow[key]), before !== null)
    }

    // Each recorded event flickers its screen, as if a line had just come up.
    if (view.events > this.events && !this.reduced) this.flicker = 1
    this.events = view.events
    if (before) {
      for (const reaction of reactionsBetween(before.look, look)) this.react(reaction)
      if (before.figure.kind !== view.figure.kind || before.figure.color !== view.figure.color) this.react({ kind: 'redressed' })
      if (before.mood !== view.mood) this.moodChanged(before.mood, view.mood)
    }
  }

  /** Show the head it wears, hide the others, and colour its skin. */
  private wear(figure: FigureChoice) {
    for (const [kind, head] of this.heads) head.visible = kind === figure.kind
    const skin = new Color(COLOR_HEX[figure.color])
    for (const mesh of this.meshes('skin')) (mesh.material as MeshStandardMaterial).color.copy(skin)
    for (const mesh of this.meshes('skin_wound')) (mesh.material as MeshStandardMaterial).color.copy(skin)
    const deep = skin.clone().multiplyScalar(0.86)
    for (const mesh of this.meshes('skin_deep')) (mesh.material as MeshStandardMaterial).color.copy(deep)
  }

  private paint(name: string, made: Texture) {
    const mesh = this.node(name) as Mesh
    const material = mesh.material as MeshStandardMaterial
    material.map?.dispose()
    material.map = made
    material.color.set('#FFFFFF')
    material.needsUpdate = true
    this.faces.set(name, mesh)
  }

  /** The recipe cards on the pegboard, one per skill, in the order the agent lists them. */
  private pinCards(skills: readonly string[], animate: boolean) {
    for (let slot = 0; slot < CARD_SLOTS; slot += 1) {
      const skill = skills[slot] ?? null
      const card = this.cards[slot]
      if (card.skill === skill) continue
      if (card.group) this.unpin(card.group, animate)
      card.group = skill ? this.pin(slot, skill, animate) : null
      card.skill = skill
    }
  }

  private pin(slot: number, skill: string, animate: boolean): Group {
    const group = new Group()
    group.name = `card_${slot + 1}_card`
    const boardGeometry = new BoxGeometry(0.21, 0.155, 0.008)
    const board = new Mesh(boardGeometry, new MeshStandardMaterial({ color: '#EFEAE0', roughness: 0.8 }))
    board.name = `card_${slot + 1}_board`
    board.castShadow = true
    const faceGeometry = new PlaneGeometry(0.2, 0.15)
    const face = new Mesh(faceGeometry, new MeshStandardMaterial({ map: cardTexture(skill, slot), roughness: 0.85 }))
    face.name = `card_${slot + 1}_face`
    face.position.z = 0.0045
    ;(face.material as MeshStandardMaterial).map!.flipY = true
    const pinGeometry = new SphereGeometry(0.014, 16, 10)
    const pin = new Mesh(pinGeometry, new MeshStandardMaterial({ color: ['#C0342E', '#D8A93C', '#2F7DD3'][slot % 3], roughness: 0.35 }))
    pin.position.set(0, 0.06, 0.016)
    pin.castShadow = true
    group.add(board, face, pin)
    group.rotation.z = MathUtils.degToRad(((slot * 37) % 7) - 3)
    this.node(`card_${slot + 1}`).add(group)
    for (const mesh of [board, face, pin]) { this.pickables.push(mesh); this.roles.set(mesh, 'card') }
    this.disposables.push(boardGeometry, faceGeometry, pinGeometry)
    if (animate && !this.reduced) {
      group.scale.setScalar(0.01)
      group.position.z = 0.25
      this.tween(group, new Vector3(0, 0, 0), new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), group.rotation.z), 0.5, 0.06)
    }
    return group
  }

  private unpin(group: Group, animate: boolean) {
    const remove = () => {
      group.removeFromParent()
      group.traverse((object) => {
        if (!(object instanceof Mesh)) return
        const index = this.pickables.indexOf(object)
        if (index >= 0) this.pickables.splice(index, 1)
        this.roles.delete(object)
        this.parts.delete(object)
        ;(object.material as MeshStandardMaterial).map?.dispose()
        ;(object.material as Material).dispose()
      })
    }
    if (!animate || this.reduced) { remove(); return }
    this.tween(group, new Vector3(0, -0.4, 0.2), group.quaternion.clone(), 0.4, 0, remove, true)
  }

  /** Hang a key on its hook (it may) or put it in your dish (it asks you first). */
  private homeKey(key: AllowSwitch, given: boolean, animate = true) {
    const node = this.node(`key_${KEY_NODE[key]}`)
    const home = this.node(given ? `hook_${KEY_NODE[key]}` : `dish_${KEY_NODE[key]}`)
    const rest = given ? this.keyHome.get(key)! : { p: this.keyDish.get(key)!, q: new Quaternion() }
    const scale = given ? 1 : DISH_KEY_SCALE
    this.tweens = this.tweens.filter((tween) => tween.node !== node)
    if (node.parent !== home) home.attach(node)
    if (!animate || this.reduced) { node.position.copy(rest.p); node.quaternion.copy(rest.q); node.scale.setScalar(scale); return }
    this.tween(node, rest.p, rest.q, 0.55, 0.18, undefined, false, scale)
  }

  private tween(node: Object3D, toP: Vector3, toQ: Quaternion, duration: number, arc: number, done?: () => void, shrink = false, toS = 1) {
    this.tweens.push({ node, fromP: node.position.clone(), toP: toP.clone(), fromQ: node.quaternion.clone(), toQ: toQ.clone(), fromS: node.scale.x, toS: shrink ? 0.01 : toS, start: this.now, duration, arc, done })
  }

  // ------------------------------------------------------------------ reacting

  private react(reaction: FigureReaction | { kind: 'redressed' }) {
    if (this.reduced) return
    const at = (kind: string, duration: number, side?: number) => this.actions.push({ kind, start: this.now, duration, side })
    switch (reaction.kind) {
      case 'renamed': at('nameplate', 1.2); break
      case 'reread': if (!this.actions.some((action) => action.kind === 'read')) at('read', 1.8); break
      case 'rethought': at('spark', 1.4); break
      case 'rebenched': at('plaque', 1.2); break
      case 'pinned': at('pin', 1.4); break
      case 'unpinned': at('unpin', 1.0); break
      case 'key': at(reaction.given ? 'keyGive' : 'keyTake', 1.1); break
      case 'redressed': at('redressed', 0.9); break
    }
  }

  private moodChanged(from: FigureMood, to: FigureMood) {
    this.moodSince = this.now
    if (to === 'done' && from !== 'done' && !this.reduced) {
      // What it wrote leaves the laptop for the tray. That is all "done" means: the run ended, not
      // that the answer is right, so there is nothing to celebrate yet.
      const envelope = this.node('envelope')
      const tray = this.node('tray')
      const rest = { p: envelope.position.clone(), q: envelope.quaternion.clone() }
      envelope.position.copy(tray.worldToLocal(this.node('laptop_lid').getWorldPosition(new Vector3()).add(new Vector3(0, 0.2, 0))))
      this.tween(envelope, rest.p, rest.q, 0.9, 0.3)
    }
  }

  // ------------------------------------------------------------------ each frame

  private tick = (time: number) => {
    if (!this.running) return
    this.frameId = requestAnimationFrame(this.tick)
    const dt = Math.min(0.05, Math.max(0, (time - this.last) / 1000))
    this.last = time
    this.now += dt
    if (this.loaded) this.update(dt)
    this.frame()
  }

  private frame() {
    this.renderer.render(this.scene, this.camera)
    if (this.loaded) this.callbacks.onFrame(this.anchors(), this.facesOnScreen())
  }

  private update(dt: number) {
    const view = this.view
    if (!view) return
    const t = this.now
    const motion = this.reduced ? 0 : 1
    const target: Pose = { ...REST }
    let look: Vector3 | 'viewer' | null = null
    const screenPoint = () => this.node('laptop_lid').getWorldPosition(new Vector3()).add(new Vector3(0, 0.12, 0))

    // The mood, from the run record.
    switch (view.mood) {
      case 'still':
        target.bodyY = 0.004 * Math.sin(t * 1.7) * motion
        target.armLRX += 0.035 * Math.sin(t * 1.3) * motion
        target.armRRX += 0.035 * Math.sin(t * 1.3 + 1.7) * motion
        break
      case 'starting':
        target.band = 0.7
        target.screen = 0.45
        look = 'viewer'
        break
      case 'working': {
        // Typing: its mittens tap the keys in turn, its arms bob a little with them.
        const tap = (phase: number) => Math.max(0, Math.sin(t * 7.5 + phase)) * (0.65 + 0.35 * Math.sin(t * 2.3 + phase))
        target.typing = 1
        target.armLRX -= 0.05 * tap(0) * motion
        target.armRRX -= 0.05 * tap(Math.PI) * motion
        target.armLRZ += 0.05 * Math.sin(t * 4.1) * motion
        target.armRRZ += 0.05 * Math.sin(t * 3.3 + 1) * motion
        target.bodyY = 0.003 * Math.abs(Math.sin(t * 15)) * motion
        target.band = 1
        target.screen = 0.75
        look = screenPoint()
        break
      }
      case 'quiet':
        // The record is quiet: hands on the keys, eyes on the screen. Nothing more, because a quiet
        // record doesn't say whether the model is thinking or the network is slow.
        target.band = 1
        target.screen = 0.5
        look = screenPoint()
        break
      case 'asking':
        target.band = 1
        target.screen = 0.5
        if (view.asked) {
          // It wants a key you keep: it points at your dish, glancing back at you.
          const glance = !this.reduced && (t - this.moodSince) % 3.2 > 2.3
          target.armRRX = -1.15
          target.armRRZ = -0.7
          look = glance ? 'viewer' : this.node(`dish_${KEY_NODE[view.asked]}`).getWorldPosition(new Vector3())
        } else {
          // It has a question for you: a hand up, looking at you.
          target.armRRX = -0.25
          target.armRRZ = -2.6 + 0.24 * Math.sin(t * 8) * motion
          target.hands = -0.3
          target.bodyY = 0.01 * Math.abs(Math.sin(t * 3.4)) * motion
          look = 'viewer'
        }
        break
      case 'done':
        look = 'viewer'
        break
      case 'failed':
        // The run stopped with a problem: its hands come off the keys, and it looks at the screen.
        target.armLRX = -0.55
        target.armRRX = -0.55
        target.armLRZ = 0.05
        target.armRRZ = -0.05
        target.lookY = -0.6
        look = screenPoint()
        break
      case 'stopped':
        break
    }

    // While a skill is dragged over the bench, it turns to the pegboard to take the card.
    if (view.dropping) look = this.node('card_3').getWorldPosition(new Vector3())
    // Otherwise, at rest, it follows what you point at, or your pointer.
    else if (!look && (view.mood === 'still' || view.mood === 'stopped' || view.mood === 'done')) {
      const at = this.hovered ? this.partPoint(this.hovered) : null
      if (at) look = at
      else if (this.pointer && !this.reduced) {
        target.lookX = MathUtils.clamp((this.pointer.x / this.width - 0.5) * 2.2, -1, 1)
        target.lookY = MathUtils.clamp(-(this.pointer.y / this.height - 0.38) * 2.2, -1, 1)
      } else if (!this.reduced) {
        target.lookX = 0.35 * Math.sin(t * 0.31) + 0.15 * Math.sin(t * 0.87)
        target.lookY = -0.35 + 0.25 * Math.sin(t * 0.43)
      }
    }

    // One-off actions: reactions to your edits, and a look around now and then while it waits.
    if (view.mood === 'still' && !this.reduced && t > this.nextFidget && this.actions.length === 0 && !this.pointer) {
      const kinds = ['lookAround', 'stretch', 'checkJob']
      this.actions.push({ kind: kinds[Math.floor(t * 7.31) % kinds.length], start: t, duration: 2.2 })
      this.nextFidget = t + 8 + (t * 13.7) % 5
    }
    this.actions = this.actions.filter((action) => t < action.start + action.duration)
    this.flashes = new Map()
    for (const action of this.actions) {
      const u = (t - action.start) / action.duration
      if (u < 0) continue
      const w = envelope(u)
      const set = (channel: Channel, value: number) => { target[channel] = MathUtils.lerp(target[channel], value, w) }
      const towards = (point: Vector3) => { look = w > 0.3 ? point : look }
      switch (action.kind) {
        case 'read':
        case 'checkJob':
          towards(this.node('job').getWorldPosition(new Vector3()))
          set('armRRX', -1.45)
          set('armRRZ', -0.42)
          break
        case 'nameplate':
          towards(this.node('nameplate').getWorldPosition(new Vector3()).add(new Vector3(0, 0.25, 0)))
          set('neckRX', 0.16)
          this.flashes.set('name', 0.55 * (1 - u))
          break
        case 'plaque':
          towards(screenPoint())
          this.flashes.set('app', 0.6 * (1 - u))
          target.band = Math.max(target.band, 1 - u)
          break
        case 'spark':
          // A new model: its head gives a little shake, the way a head clears.
          target.scale += 0.12 * bump(u * 1.6)
          target.neckRZ += 0.09 * Math.sin(u * 40) * (1 - u)
          this.flashes.set('mind', 0.45 * (1 - u))
          break
        case 'redressed':
          // A new figure: it pops into its new head and looks at you.
          target.scale += 0.18 * bump(u * 1.3)
          target.bodyY += 0.03 * bump(u * 1.3)
          look = 'viewer'
          break
        case 'pin':
        case 'unpin':
          towards(this.node('card_3').getWorldPosition(new Vector3()))
          target.bodyY += 0.025 * bump(u * 2)
          break
        case 'keyGive':
          towards(this.node('hooks').getWorldPosition(new Vector3()))
          target.bodyY += 0.025 * bump(u * 2)
          break
        case 'keyTake':
          towards(this.node('dish').getWorldPosition(new Vector3()))
          set('bodyRX', 0.05)
          break
        case 'lookAround':
          towards(this.node(u < 0.5 ? 'hooks' : 'card_3').getWorldPosition(new Vector3()))
          break
        case 'stretch':
          set('hands', -0.3)
          set('armLRX', -0.2)
          set('armLRZ', 2.0)
          set('armRRX', -0.2)
          set('armRRZ', -2.0)
          target.bodyY += 0.015 * bump(u)
          break
      }
    }

    // Looking at a point: its head turns and nods toward it, and its body turns a little.
    if (look) {
      const head = this.node('head').getWorldPosition(new Vector3())
      const point = look === 'viewer' ? this.camera.position.clone() : look
      const toward = point.sub(head)
      const behind = toward.z < -0.1
      target.lookX = MathUtils.clamp(toward.x / 0.75, -1, 1)
      target.lookY = MathUtils.clamp(toward.y / 0.6, -1, 1)
      target.bodyRY = MathUtils.clamp((behind ? -toward.x : toward.x) * 0.25, -BODY_TURN, BODY_TURN)
    } else target.bodyRY = target.lookX * BODY_TURN

    // Ease every channel toward its target.
    const ease = this.reduced ? 1 : 1 - Math.exp(-dt * 8)
    for (const channel of Object.keys(target) as Channel[]) this.pose[channel] += (target[channel] - this.pose[channel]) * ease

    const p = this.pose
    const body = this.node('body')
    body.position.y = p.bodyY
    body.rotation.set(p.bodyRX, p.bodyRY, 0)
    this.node('neck').rotation.set(p.neckRX - p.lookY * 0.05, 0, p.neckRZ - p.lookX * 0.06)
    const head = this.node('head')
    head.rotation.set(-p.lookY * HEAD_NOD, p.lookX * HEAD_TURN, 0)
    head.scale.setScalar(p.scale)
    this.node('arm_l').rotation.set(p.armLRX, 0, p.armLRZ)
    this.node('arm_r').rotation.set(p.armRRX, 0, p.armRRZ)
    this.mittens(p, motion)
    this.blink()

    const light = this.node('laptop_light') as Mesh
    const band = light.material as MeshStandardMaterial
    band.emissive.copy(LIVE)
    band.emissiveIntensity = p.band * (this.reduced ? 1 : 0.75 + 0.25 * Math.sin(t * 5))
    this.flicker = Math.max(0, this.flicker - dt * 4)
    const screen = (this.node('laptop_screen') as Mesh).material as MeshStandardMaterial
    screen.emissiveIntensity = p.screen + this.flicker * 0.9
    if (this.screenLight) this.screenLight.intensity = (p.screen + this.flicker * 0.6) * 0.35
    this.highlight(view)

    this.liftAsked(view)

    // Keys and cards on their way somewhere.
    this.tweens = this.tweens.filter((tween) => {
      const u = MathUtils.clamp((this.now - tween.start) / tween.duration, 0, 1)
      const k = 1 - (1 - u) ** 3
      tween.node.position.lerpVectors(tween.fromP, tween.toP, k)
      tween.node.position.y += tween.arc * bump(u)
      tween.node.quaternion.slerpQuaternions(tween.fromQ, tween.toQ, k)
      tween.node.scale.setScalar(MathUtils.lerp(tween.fromS, tween.toS, k))
      if (u >= 1) { tween.done?.(); return false }
      return true
    })
  }

  /** Its mittens: while it types each one taps on its own beat; open when it waves or stretches. */
  private mittens(p: Pose, motion: number) {
    const t = this.now
    for (const [side, phase] of [['l', 0], ['r', 1.9]] as const) {
      const tap = Math.max(0, Math.sin(t * 11 + phase)) ** 3
      this.node(`hand_${side}`).rotation.x = p.hands + p.typing * 0.35 * tap * motion
    }
  }

  /** Now and then it blinks: both eyes close for a moment. Not under reduced motion. */
  private blink() {
    if (this.reduced) return
    const since = this.now - this.nextBlink
    const shut = since < 0 ? 1 : since < 0.14 ? 0.12 + 0.88 * Math.abs(since / 0.07 - 1) : 1
    if (since >= 0.14) this.nextBlink = this.now + 2.6 + ((this.now * 7.13) % 3.4)
    for (const eye of this.eyes) eye.scale.y = shut
  }

  /** The key it asks you for lifts out of your dish and bobs, so you can see which one it means. */
  private liftAsked(view: BenchView) {
    for (const { key } of FIGURE_KEYS) {
      const node = this.node(`key_${KEY_NODE[key]}`)
      if (view.look.allow[key] || this.drag?.key === key || !node.parent || this.tweens.some((tween) => tween.node === node)) continue
      const lift = view.asked === key ? 0.06 + (this.reduced ? 0 : 0.02 * Math.sin(this.now * 5)) : 0
      const up = new Vector3(0, 1, 0).applyQuaternion(node.parent.getWorldQuaternion(new Quaternion()).invert())
      node.position.copy(this.keyDish.get(key)!).addScaledVector(up, lift)
    }
  }

  /** The part under the pointer glows faintly, the open one a little more, the key it asks for pulses. */
  private highlight(view: BenchView) {
    for (const [mesh, role] of this.roles) {
      if (role === 'eye' || role === 'glint' || role === 'screen' || mesh.name === 'laptop_light') continue
      const part = this.partOf(mesh)
      const material = mesh.material as MeshStandardMaterial
      let amount = part ? this.flashes.get(part) ?? 0 : 0
      if (part && part === this.hovered) amount = Math.max(amount, 0.16)
      if (part && part === view.open) amount = Math.max(amount, 0.1)
      if (view.dropping && mesh.name === 'pegboard_face') amount = 0.12
      const keyName = mesh.parent?.name ?? ''
      if (view.asked && keyName === `key_${KEY_NODE[view.asked]}`) amount = Math.max(amount, this.reduced ? 0.35 : 0.2 + 0.25 * (0.5 + 0.5 * Math.sin(this.now * 6)))
      if (this.hoveredKey && keyName === `key_${KEY_NODE[this.hoveredKey]}`) amount = Math.max(amount, 0.3)
      material.emissive.copy(HIGHLIGHT)
      material.emissiveIntensity = amount
    }
  }

  // ------------------------------------------------------------------ where things are

  private anchors(): BenchAnchors {
    const world = (name: string, offset: [number, number, number]) => this.node(name).getWorldPosition(new Vector3()).add(new Vector3(...offset))
    const cards = world('card_1', [0, 0, 0]).lerp(world('card_2', [0, 0, 0]), 0.5).add(new Vector3(0, 0.11, 0))
    return {
      mind: this.screen(world('neck', [0.33, 0.3, 0])),
      app: this.screen(world('laptop_face', [0, 0, 0])),
      name: this.screen(world('nameplate', [0, 0, 0])),
      job: this.screen(world('job', [0, 0.3, -0.12])),
      skills: this.screen(cards),
      keys: this.screen(world('hooks', [0, 0.06, 0])),
      dish: this.screen(world('dish', [0, -0.01, 0.2])),
      reply: this.screen(world('tray', [0, 0.1, -0.05])),
    }
  }

  private facesOnScreen(): BenchFaces {
    const quad = (face: BenchFace): BenchQuad => {
      const mesh = this.node(FACE_MESH[face])
      const [a, b, c] = this.faceCorners.get(face)!.map((corner) => this.screen(mesh.localToWorld(corner.clone())))
      return { x: a.x, y: a.y, ux: b.x - a.x, uy: b.y - a.y, vx: c.x - a.x, vy: c.y - a.y }
    }
    return { name: quad('name'), job: quad('job'), app: quad('app') }
  }

  private partPoint(part: FigurePart): Vector3 | null {
    const name = { mind: null, app: 'laptop_lid', name: 'nameplate', job: 'job', skills: 'card_3', keys: 'hooks', reply: 'tray' }[part]
    return name ? this.node(name).getWorldPosition(new Vector3()) : null
  }

  private screen(point: Vector3) {
    const projected = point.clone().project(this.camera)
    return { x: (projected.x + 1) / 2 * this.width, y: (1 - projected.y) / 2 * this.height }
  }

  private ray(x: number, y: number) {
    this.raycaster.setFromCamera(new Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1), this.camera)
    return this.raycaster
  }

  private pick(x: number, y: number): { part: FigurePart | null; key: AllowSwitch | null } | null {
    // A ray finds hidden things too: the heads it doesn't wear are still in the scene.
    const hit = this.ray(x, y).intersectObjects(this.pickables, false).find((candidate) => shown(candidate.object))
    if (!hit) return null
    const names: string[] = []
    for (let object: Object3D | null = hit.object; object; object = object.parent) if (object.name) names.push(object.name)
    const key = FIGURE_KEYS.find(({ node }) => names.includes(`key_${node}`))?.key ?? null
    return { part: partOfNode(names), key }
  }

  private partOf(mesh: Mesh): FigurePart | null {
    if (this.parts.has(mesh)) return this.parts.get(mesh) ?? null
    const names: string[] = []
    for (let object: Object3D | null = mesh; object; object = object.parent) if (object.name) names.push(object.name)
    const part = partOfNode(names)
    this.parts.set(mesh, part)
    return part
  }

  private meshes(role: string): Mesh[] {
    return [...this.roles].filter(([, value]) => value === role).map(([mesh]) => mesh)
  }

  private node(name: string): Object3D {
    const found = this.nodes.get(name)
    if (!found) throw new Error(`The workbench has no “${name}”.`)
    return found
  }

  /** Frame the bench, the figure and the pegboard, whatever the shape of the stage. */
  private fit() {
    const target = new Vector3(0, 0.8, -0.3)
    // From a little above and nearly straight on: high enough to see its hands over the laptop's lid.
    const direction = new Vector3(0.06, 0.56, 1).normalize()
    // The things that reach furthest: the pegboard's top corners, the bench's front corners, the head.
    const corners = [-1.06, 1.06].flatMap((x) => [new Vector3(x, 1.62, -1.1), new Vector3(x, 0.66, 0.38), new Vector3(x, 0, 0.38)]).concat([new Vector3(0, 1.62, -0.6)])
    this.camera.updateProjectionMatrix()
    let near = 1
    let far = 12
    for (let step = 0; step < 24; step += 1) {
      const distance = (near + far) / 2
      this.camera.position.copy(target).addScaledVector(direction, distance)
      this.camera.lookAt(target)
      this.camera.updateMatrixWorld()
      // Room above for the labels that sit on the pegboard's top edge.
      const fits = corners.every((corner) => { const p = corner.clone().project(this.camera); return Math.abs(p.x) < 0.95 && p.y < 0.84 && p.y > -0.96 })
      if (fits) far = distance
      else near = distance
    }
    this.camera.position.copy(target).addScaledVector(direction, far)
    this.camera.lookAt(target)
    this.camera.updateProjectionMatrix()
  }

  private material(role: string, mesh: string): Material {
    return benchMaterial(role, mesh, { pegboard: () => this.own(pegboardTexture()), wound: this.wound })
  }

  private own<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item)
    return item
  }
}

/**
 * Size a renderer's canvas to its box in whole device pixels, and say the size in CSS pixels it
 * now draws at. A drawing buffer even part of a pixel smaller than the box it fills is stretched to
 * fit, which resamples the whole picture and leaves it soft, worst on a 1x screen. So the canvas
 * takes exactly the size of its buffer: at most a fraction of a pixel short of its box. Shared with
 * the landing page's crew (src/site/crewScene.ts).
 */
export function fitCanvas(renderer: WebGLRenderer, width: number, height: number): { width: number; height: number } {
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  const across = Math.max(1, Math.floor(width * ratio))
  const down = Math.max(1, Math.floor(height * ratio))
  // In device pixels, at a ratio of 1: three floors width × ratio itself, which can land a pixel short.
  renderer.setDrawingBufferSize(across, down, 1)
  renderer.domElement.style.width = `${across / ratio}px`
  renderer.domElement.style.height = `${down / ratio}px`
  return { width: across / ratio, height: down / ratio }
}

/**
 * The look of each material in workbench.glb, by the role Blender named it. The figure's skin is
 * coloured when it is dressed. Shared with the landing page's crew (src/site/crewScene.ts), so a
 * figure looks the same there as on its bench.
 */
export function benchMaterial(role: string, mesh: string, textures: { pegboard: () => Texture; wound: Texture | null }): Material {
  const physical = (color: string, roughness: number, clearcoat = 0.4) => new MeshPhysicalMaterial({ color, roughness, clearcoat, clearcoatRoughness: 0.35 })
  const standard = (color: string, roughness: number, metalness = 0) => new MeshStandardMaterial({ color, roughness, metalness })
  switch (role) {
    case 'bone': return physical('#EFEAE0', 0.5, 0.55)
    case 'benchtop': return physical('#E6DFD1', 0.6, 0.3)
    case 'graphite': return physical('#24242B', 0.55, 0.35)
    case 'shoe': return physical('#2B2B33', 0.55, 0.3)
    case 'pegboard': return mesh === 'pegboard_face' ? new MeshStandardMaterial({ map: textures.pegboard(), roughness: 0.9 }) : standard('#1C1C21', 0.8)
    // The figure. Its skin is coloured when it is dressed (wear), from the figure it wears.
    case 'skin': return new MeshPhysicalMaterial({ color: '#E3A386', roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.4, sheen: 0.3, sheenRoughness: 0.6, sheenColor: '#FFFFFF' })
    case 'skin_wound': return new MeshStandardMaterial({ color: '#E3A386', roughness: 0.78, bumpMap: textures.wound, bumpScale: 1.6 })
    case 'skin_deep': return new MeshStandardMaterial({ color: '#C38C73', roughness: 0.62 })
    case 'eye': return new MeshPhysicalMaterial({ color: '#1E1E26', roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.08 })
    case 'glint': return new MeshBasicMaterial({ color: '#FFFFFF' })
    case 'stitch': return standard('#D8A93C', 0.35, 0.6)
    case 'wood': return physical('#E9D5B1', 0.55, 0.3)
    case 'leaf': return physical('#6E9C6A', 0.5, 0.3)
    case 'steel': return standard('#C9CCD2', 0.3, 0.9)
    case 'pin_a': return physical('#E9C46A', 0.3, 0.6)
    case 'pin_b': return physical('#F4F1EA', 0.3, 0.6)
    case 'pin_c': return physical('#4A4A55', 0.3, 0.6)
    case 'scarf': return new MeshStandardMaterial({ color: '#FFFFFF', roughness: 0.82, bumpScale: 3 })
    case 'gold': return standard('#E2B451', 0.3, 1)
    case 'appband': return new MeshStandardMaterial({ color: '#85817A', emissive: LIVE, emissiveIntensity: 0, roughness: 0.4 })
    case 'screen': return new MeshStandardMaterial({ color: '#141A24', emissive: LIVE, emissiveIntensity: 0.12, roughness: 0.3 })
    // The worded faces are left plain: AgentFigure lays their words over them as page text.
    case 'paper': return standard(mesh === 'laptop_face' ? '#2B2B33' : mesh === 'nameplate_face' ? '#EFEAE0' : '#F4EFE4', 0.85)
    case 'ink': return standard('#B9B1A2', 0.85)
    case 'tag_web': return standard('#E9C46A', 0.5)
    case 'tag_files': return standard('#EFEAE0', 0.55)
    case 'tag_cmd': return standard('#3A3A44', 0.55)
    default: return standard('#888888', 0.6)
  }
}
