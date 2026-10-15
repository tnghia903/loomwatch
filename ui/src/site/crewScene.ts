import {
  Box3,
  CatmullRomCurve3,
  Color,
  DirectionalLight,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  NeutralToneMapping,
  Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Raycaster,
  Scene,
  ShadowMaterial,
  TubeGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
} from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

import { benchMaterial, fitCanvas } from '../components/agents/workbenchScene'
import { pegboardTexture, swatchTextures, woundTexture } from '../components/agents/benchTextures'
import { COLOR_HEX, FIGURE_KINDS, type FigureChoice } from '../lib/library/figures'
import { markPattern } from '../lib/story/mark'

/** One figure in the crew: who it is (its scarf is woven from this) and what it wears. */
export interface CrewMember {
  id: string
  figure: FigureChoice
}

export interface CrewCallbacks {
  /** The figure under the pointer, or null. */
  onHover: (index: number | null) => void
  onPick: (index: number) => void
  /** Each frame: the top of each figure's head, in CSS pixels from the canvas's top left. */
  onFrame: (heads: readonly { x: number; y: number }[]) => void
}

interface Figure {
  root: Object3D
  body: Object3D
  neck: Object3D
  head: Object3D
  armL: Object3D
  armR: Object3D
  handL: Object3D
  handR: Object3D
  eyes: Object3D[]
  meshes: Mesh[]
  pose: Pose
  nextBlink: number
  /** Its own beat, so six figures never breathe in step. */
  phase: number
  hop: number
}

/** Holding the thread: both mittens forward and a little in, at the waist. */
const REST = { bodyY: 0, bodyRY: 0, lookX: 0, lookY: 0, armLRX: -0.62, armLRZ: -0.16, armRRX: -0.62, armRRZ: 0.16, wave: 0 }
type Pose = typeof REST

const SPACING = 0.78
const HEAD_TURN = 0.5
const HEAD_NOD = 0.24

/**
 * The landing page's crew: the app's own figures (workbench.glb, the same model and materials as
 * Build by hand), six of them standing in a row and holding one gold thread. Alive the way the
 * figure on its bench is between runs: they breathe, blink, and look where you point. The one
 * under the pointer lets go of the thread with one mitten and waves, and the others look at it.
 * Reduced motion keeps the poses and drops the motion.
 */
export class CrewScene {
  private readonly renderer: WebGLRenderer
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(22, 1, 0.1, 40)
  private readonly raycaster = new Raycaster()
  private readonly callbacks: CrewCallbacks
  private readonly reduced: boolean
  private readonly members: readonly CrewMember[]
  private readonly figures: Figure[] = []
  private readonly disposables: { dispose: () => void }[] = []
  private width = 1
  private height = 1
  private running = false
  private loaded = false
  private frameId = 0
  private last = 0
  private now = 0
  /** Where the pointer is, in this canvas's CSS pixels; it may be outside the canvas. */
  private pointer: Vector2 | null = null
  private hovered: number | null = null
  private nextFidget = 3
  private standY = 0
  private headTop = 1
  /** Which figures stand in each row, front row first: one row of six, or two of three. */
  private rows: number[][] = []
  private threads: Mesh<TubeGeometry, MeshStandardMaterial>[] = []
  private threadMaterial: MeshStandardMaterial | null = null

  constructor(canvas: HTMLCanvasElement, members: readonly CrewMember[], callbacks: CrewCallbacks, reduced: boolean) {
    this.members = members
    this.callbacks = callbacks
    this.reduced = reduced
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' })
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.toneMapping = NeutralToneMapping
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = PCFShadowMap

    const pmrem = new PMREMGenerator(this.renderer)
    const room = new RoomEnvironment()
    this.scene.environment = pmrem.fromScene(room, 0.04).texture
    this.scene.environmentIntensity = 0.55
    room.dispose()
    pmrem.dispose()

    this.scene.add(new HemisphereLight('#FFF6E8', '#2A2A32', 0.75))
    const key = new DirectionalLight('#FFF3E2', 2.3)
    key.position.set(-1.6, 4.2, 3.4)
    key.castShadow = true
    key.shadow.mapSize.set(1024, 1024)
    key.shadow.camera.left = -3.2
    key.shadow.camera.right = 3.2
    key.shadow.camera.top = 2
    key.shadow.camera.bottom = -1
    key.shadow.camera.near = 0.5
    key.shadow.camera.far = 10
    key.shadow.bias = -0.0004
    key.shadow.normalBias = 0.02
    key.shadow.radius = 4
    key.target.position.set(0, 0.5, 0)
    this.scene.add(key, key.target)
    const rim = new DirectionalLight('#DDE6FF', 1.0)
    rim.position.set(2.5, 2.2, -2.5)
    this.scene.add(rim)

    const floorGeometry = new PlaneGeometry(14, 8)
    const floorMaterial = new ShadowMaterial({ opacity: 0.2 })
    const floor = new Mesh(floorGeometry, floorMaterial)
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    this.scene.add(floor)
    this.disposables.push(floorGeometry, floorMaterial)
  }

  async load(url: string): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(url)
    const source = gltf.scene.getObjectByName('figure')
    if (!source) throw new Error('The model has no figure.')
    source.removeFromParent()
    source.position.set(0, 0, 0)
    source.updateMatrixWorld(true)
    const box = new Box3().setFromObject(source, true)
    this.standY = -box.min.y
    const wound = this.own(woundTexture())
    const pegboard = () => this.own(pegboardTexture())
    this.members.forEach((member, index) => {
      const root = source.clone(true)
      const meshes: Mesh[] = []
      const skin = new Color(COLOR_HEX[member.figure.color])
      const swatch = swatchTextures(markPattern(member.id).over)
      this.own(swatch.map)
      this.own(swatch.bump)
      root.traverse((object) => {
        if (!(object instanceof Mesh)) return
        const role = (object.material as Material).name
        const material = benchMaterial(role, object.name, { pegboard, wound })
        if (role === 'skin' || role === 'skin_wound') (material as MeshStandardMaterial).color.copy(skin)
        if (role === 'skin_deep') (material as MeshStandardMaterial).color.copy(skin).multiplyScalar(0.86)
        if (role === 'scarf') {
          ;(material as MeshStandardMaterial).map = swatch.map
          ;(material as MeshStandardMaterial).bumpMap = swatch.bump
        }
        object.material = material
        object.castShadow = role !== 'glint' && !object.name.endsWith('_face')
        object.receiveShadow = role !== 'glint'
        object.userData.member = index
        meshes.push(object)
        this.own(material)
      })
      const named = (name: string) => {
        const found = root.getObjectByName(name)
        if (!found) throw new Error(`The figure has no “${name}”.`)
        return found
      }
      for (const kind of FIGURE_KINDS) named(`head_${kind}`).visible = kind === member.figure.kind
      const eyes: Object3D[] = []
      root.traverse((object) => { if (/_eye_[lr]$/.test(object.name)) eyes.push(object) })
      this.scene.add(root)
      this.figures.push({
        root, body: named('body'), neck: named('neck'), head: named('head'), armL: named('arm_l'), armR: named('arm_r'),
        handL: named('hand_l'), handR: named('hand_r'), eyes, meshes, pose: { ...REST },
        nextBlink: 1.5 + ((index * 1.37) % 2.6), phase: index * 1.618, hop: -10,
      })
    })
    for (const geometry of new Set(this.figures.flatMap((figure) => figure.meshes.map((mesh) => mesh.geometry)))) this.disposables.push(geometry)
    source.traverse((object) => { if (object instanceof Mesh) (object.material as Material).dispose() })
    // Measured where it stands on the floor.
    this.headTop = new Box3().setFromObject(this.figures[0].root, true).max.y + this.standY
    this.threadMaterial = this.own(new MeshStandardMaterial({ color: '#E2B451', roughness: 0.32, metalness: 1, emissive: new Color('#E9C46A'), emissiveIntensity: 0.18 }))
    this.loaded = true
    this.layout()
    this.frame()
  }

  /**
   * Stand the crew for the stage: one shallow arc on a wide one; on a narrow one (a phone), two
   * rows of three like a group photo, the back row between the front row's heads. Each row holds
   * its own thread.
   */
  private layout() {
    const count = this.figures.length
    const narrow = this.width / this.height < 1.25
    const half = Math.ceil(count / 2)
    const rows = narrow ? [Array.from({ length: half }, (_, i) => i), Array.from({ length: count - half }, (_, i) => half + i)] : [Array.from({ length: count }, (_, i) => i)]
    const same = rows.length === this.rows.length
    this.rows = rows
    rows.forEach((row, r) => row.forEach((index, at) => {
      // The back row stands half a place over, so its heads show between the front row's.
      const offset = at - (row.length - 1) / 2 + (r === 1 ? 0.5 : 0)
      const figure = this.figures[index].root
      // A shallow arc, the ends a little forward, each turned a touch toward the middle.
      figure.position.set(offset * SPACING, this.standY, r === 1 ? -0.95 : -0.06 * offset * offset)
      figure.rotation.y = -offset * 0.07
    }))
    if (!same || this.threads.length === 0) {
      for (const thread of this.threads) { thread.geometry.dispose(); thread.removeFromParent() }
      this.threads = rows.map(() => {
        const thread = new Mesh(new TubeGeometry(new CatmullRomCurve3([new Vector3(), new Vector3(0.1, 0, 0)]), 2, 0.012, 6), this.threadMaterial!)
        thread.castShadow = true
        this.scene.add(thread)
        return thread
      })
    }
    this.scene.updateMatrixWorld(true)
    this.weave()
    this.fit()
  }

  private weave() {
    this.rows.forEach((row, r) => {
      const thread = this.threads[r]
      if (!thread) return
      thread.geometry.dispose()
      thread.geometry = new TubeGeometry(this.threadCurve(row.map((index) => this.figures[index])), 40 * row.length, 0.012, 6)
    })
  }

  resize(width: number, height: number) {
    const size = fitCanvas(this.renderer, width, height)
    this.width = size.width
    this.height = size.height
    this.camera.aspect = this.width / this.height
    if (this.loaded) this.layout()
    if (this.loaded && !this.running) this.frame()
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
    for (const thread of this.threads) thread.geometry.dispose()
    for (const item of this.disposables) item.dispose()
    this.scene.environment?.dispose()
    this.renderer.dispose()
  }

  /** The pointer, in this canvas's CSS pixels; null when it leaves the page. */
  pointerMove(x: number | null, y: number | null) {
    this.pointer = x === null || y === null ? null : new Vector2(x, y)
    const over = this.pointer && this.loaded ? this.pick(this.pointer.x, this.pointer.y) : null
    if (over !== this.hovered) {
      this.hovered = over
      this.callbacks.onHover(over)
    }
  }

  /** A click or tap at this point: the figure there, if any, is picked. */
  pointerUp(x: number, y: number) {
    const picked = this.loaded ? this.pick(x, y) : null
    if (picked !== null) this.callbacks.onPick(picked)
  }

  private pick(x: number, y: number): number | null {
    if (x < 0 || y < 0 || x > this.width || y > this.height) return null
    this.raycaster.setFromCamera(new Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1), this.camera)
    const meshes = this.figures.flatMap((figure) => figure.meshes)
    const hit = this.raycaster.intersectObjects(meshes, false).find((candidate) => {
      for (let at: Object3D | null = candidate.object; at; at = at.parent) if (!at.visible) return false
      return true
    })
    return hit ? (hit.object.userData.member as number) : null
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
    if (this.loaded) this.callbacks.onFrame(this.figures.map((figure) => this.screen(figure.head.getWorldPosition(new Vector3()).setY(this.headTop + 0.04))))
  }

  private update(dt: number) {
    const t = this.now
    const motion = this.reduced ? 0 : 1
    const hovered = this.hovered

    // Now and then one of them hops, or turns to look at its neighbour, while nobody points.
    if (!this.reduced && t > this.nextFidget && hovered === null) {
      const which = Math.floor((t * 7.31) % this.figures.length)
      this.figures[which].hop = t
      this.nextFidget = t + 3.5 + ((t * 13.7) % 4)
    }

    this.figures.forEach((figure, index) => {
      const target: Pose = { ...REST }
      const beat = t + figure.phase
      target.bodyY = 0.006 * Math.sin(beat * 1.6) * motion
      target.armLRX += 0.04 * Math.sin(beat * 1.3) * motion
      target.armRRX += 0.04 * Math.sin(beat * 1.3 + 1.7) * motion

      const head = figure.head.getWorldPosition(new Vector3())
      let look: Vector3 | null = null
      if (hovered !== null && hovered !== index) look = this.figures[hovered].head.getWorldPosition(new Vector3())
      if (look) {
        const toward = look.sub(head)
        target.lookX = MathUtils.clamp(toward.x / 0.9, -1, 1)
        target.lookY = MathUtils.clamp(toward.y / 0.6, -1, 1) - 0.1
      } else if (this.pointer && !this.reduced) {
        // Everyone looks where you point, each from where it stands.
        const at = this.screen(head)
        target.lookX = MathUtils.clamp((this.pointer.x - at.x) / (this.width * 0.45), -1, 1)
        target.lookY = MathUtils.clamp(-(this.pointer.y - at.y) / (this.height * 0.6), -1, 1)
      } else if (!this.reduced) {
        target.lookX = 0.3 * Math.sin(beat * 0.31) + 0.12 * Math.sin(beat * 0.87)
        target.lookY = 0.1 * Math.sin(beat * 0.43)
      }

      if (hovered === index) {
        // It lets go with its right mitten and waves at you.
        target.wave = 1
        target.armRRX = -0.25
        target.armRRZ = -2.55 + 0.26 * Math.sin(t * 8) * motion
        target.bodyY += 0.012 * Math.abs(Math.sin(t * 3.4)) * motion
        target.lookX = this.pointer ? target.lookX * 0.5 : 0
        target.lookY = 0.15
      }
      const hop = t - figure.hop
      if (hop >= 0 && hop < 0.7) {
        target.bodyY += 0.06 * Math.sin(Math.PI * hop / 0.7)
        target.lookX = index === 0 ? 0.8 : -0.8
      }
      target.bodyRY = target.lookX * 0.1

      const ease = this.reduced ? 1 : 1 - Math.exp(-dt * 7)
      for (const channel of Object.keys(target) as (keyof Pose)[]) figure.pose[channel] += (target[channel] - figure.pose[channel]) * ease
      const p = figure.pose
      figure.body.position.y = p.bodyY
      figure.body.rotation.set(0, p.bodyRY, 0)
      figure.neck.rotation.set(-p.lookY * 0.05, 0, -p.lookX * 0.06)
      figure.head.rotation.set(-p.lookY * HEAD_NOD, p.lookX * HEAD_TURN, 0)
      figure.armL.rotation.set(p.armLRX, 0, p.armLRZ)
      figure.armR.rotation.set(p.armRRX, 0, p.armRRZ)
      figure.handR.rotation.x = -0.3 * p.wave
      this.blink(figure)
    })

    this.scene.updateMatrixWorld(true)
    this.weave()
  }

  /** Through every mitten that holds it, sagging between neighbours and trailing off at both ends. */
  private threadCurve(figures: readonly Figure[]): CatmullRomCurve3 {
    const points: Vector3[] = []
    const mitten = (hand: Object3D) => hand.localToWorld(new Vector3(0, -0.05, 0.02))
    const t = this.now
    figures.forEach((figure, index) => {
      const right = mitten(figure.handR)
      const left = mitten(figure.handL)
      if (index === 0) points.push(right.clone().add(new Vector3(-0.55, -0.1, 0.05)), right.clone().add(new Vector3(-0.28, -0.07 + 0.01 * Math.sin(t * 1.4), 0.03)))
      else {
        const before = mitten(figures[index - 1].handL)
        const sag = 0.09 + 0.012 * Math.sin(t * 1.2 + index) * (this.reduced ? 0 : 1)
        points.push(before.clone().lerp(right, 0.5).add(new Vector3(0, -sag, 0.04)))
      }
      // A waving figure holds it with one mitten only: the thread slides from its left to its right.
      const waving = figure.pose.wave > 0.5
      points.push(waving ? left.clone().lerp(right, 0.5).add(new Vector3(0, -0.05, 0.05)) : right, left)
      if (index === figures.length - 1) points.push(left.clone().add(new Vector3(0.28, -0.07 + 0.01 * Math.sin(t * 1.1), 0.03)), left.clone().add(new Vector3(0.55, -0.12, 0.05)))
    })
    return new CatmullRomCurve3(points, false, 'centripetal')
  }

  private blink(figure: Figure) {
    if (this.reduced) return
    const since = this.now - figure.nextBlink
    const shut = since < 0 ? 1 : since < 0.14 ? 0.12 + 0.88 * Math.abs(since / 0.07 - 1) : 1
    if (since >= 0.14) figure.nextBlink = this.now + 2.2 + ((this.now * 7.13 + figure.phase) % 3.6)
    for (const eye of figure.eyes) eye.scale.y = shut
  }

  /** Frame the whole crew and its thread, whatever the shape of the stage. */
  private fit() {
    if (!this.loaded) return
    const xs = this.figures.map((figure) => figure.root.position.x)
    const zs = this.figures.map((figure) => figure.root.position.z)
    const left = Math.min(...xs) - 0.62
    const right = Math.max(...xs) + 0.62
    const back = Math.min(...zs)
    const front = Math.max(...zs)
    const target = new Vector3((left + right) / 2, this.headTop * 0.5, (back + front) / 2)
    // Two rows are seen from a little higher, so the back row's heads clear the front row's.
    const direction = new Vector3(0, this.rows.length > 1 ? 0.42 : 0.2, 1).normalize()
    const corners = [left, right].flatMap((x) => [new Vector3(x, 0, front + 0.2), new Vector3(x, this.headTop + 0.1, back)])
    this.camera.updateProjectionMatrix()
    let near = 1
    let far = 30
    for (let step = 0; step < 24; step += 1) {
      const distance = (near + far) / 2
      this.camera.position.copy(target).addScaledVector(direction, distance)
      this.camera.lookAt(target)
      this.camera.updateMatrixWorld()
      const fits = corners.every((corner) => { const p = corner.clone().project(this.camera); return Math.abs(p.x) < 0.97 && Math.abs(p.y) < 0.86 })
      if (fits) far = distance
      else near = distance
    }
    this.camera.position.copy(target).addScaledVector(direction, far)
    this.camera.lookAt(target)
    this.camera.updateProjectionMatrix()
  }

  private screen(point: Vector3) {
    const projected = point.clone().project(this.camera)
    return { x: ((projected.x + 1) / 2) * this.width, y: ((1 - projected.y) / 2) * this.height }
  }

  private own<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item)
    return item
  }
}

