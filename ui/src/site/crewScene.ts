import {
  AdditiveBlending,
  Box3,
  CatmullRomCurve3,
  Color,
  DirectionalLight,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NeutralToneMapping,
  Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  ShaderMaterial,
  ShadowMaterial,
  SphereGeometry,
  SpotLight,
  TubeGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
  type Texture,
  type Vector4,
} from 'three'
import { benchMaterial, drawn, fitCanvas, readModel, readyToDraw, roomEnvironment } from '../components/agents/workbenchScene'
import { pegboardTexture, woundTexture } from '../components/agents/benchTextures'
import { COLOR_HEX, FIGURE_KINDS, type FigureChoice } from '../lib/library/figures'
import { CrewGlow, easeTint, glowColor } from './crewGlow'
import { glowAt, talkAt, type Glow, type TalkLine, type TalkState } from './crewTalk'

/** One figure in the crew: what it wears. */
export interface CrewMember {
  figure: FigureChoice
}

export interface CrewCallbacks {
  /** The figure under the pointer, or null. */
  onHover: (index: number | null) => void
  onPick: (index: number) => void
  /**
   * Each frame: the top of each figure's head, in CSS pixels from the canvas's top left, and where
   * the conversation is (null when there is none, or while a figure is under the pointer).
   */
  onFrame: (heads: readonly { x: number; y: number }[], talk: TalkState | null) => void
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
  /** Its flat colour in the glow round it: what it is doing (crewGlow.ts). */
  tint: ShaderMaterial
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
/** How strongly a figure glows: ready, waiting for you, working (breathing between these), and pointed at. */
const GLOW = { ready: 0.45, waiting: 1, working: [0.6, 1], hovered: 1 } as const
/** One breath of a working figure's glow, in seconds, as in the page's chat. */
const BREATH = 2.4
/** How dark the shadows on the floor are while the lamp is lit. */
const SHADOW = 0.2
/**
 * Where the lamp hangs: on the line from the camera through the bulb, at this much of the way to
 * the crew (1 is level with them, so their shadows fall straight to the side), then this many times
 * as far from them in that direction (further out, the shadows are shorter and more nearly alike).
 */
const LAMP = { depth: 0.8, out: 3 }

/**
 * The landing page's crew: the app's own figures (workbench.glb, the same model and materials as
 * Build by hand), six of them standing in a row and holding one gold thread. Alive the way the
 * figure on its bench is between runs: they breathe, blink, and look where you point. The one
 * under the pointer lets go of the thread with one mitten and waves, and the others look at it.
 * Given a script (talk()), they act out a hand-off: the one talking bobs as it speaks, the others
 * look at it, a gold bead carries the work along the thread to the next, and when it reaches you
 * they all look out and the last one waves. Each glows round its outline what it is doing, as an
 * agent's figure does in the app: green ready, blue working (breathing), gold waiting for you; the
 * one under the pointer glows wider. The page's lamp lights them (lamp()): their shadows fall away
 * from its bulb, and with it off they cast none. Reduced motion keeps the poses and drops the
 * motion, the conversation with it.
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
  /** Loaded, and its shaders compiled: it draws, and answers the pointer. */
  private ready = false
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
  /** Each row's thread, and where along it each figure holds it (its curve's t, between the mittens). */
  private curves: CatmullRomCurve3[] = []
  private held: { row: number; t: number }[] = []
  /** The conversation: its script, how many times it plays, and its own clock, which stops while paused. */
  private script: readonly TalkLine[] | null = null
  private loops = 1
  private talkClock = 0
  private talking = false
  private talkState: TalkState | null = null
  private passTo: number | null = null
  /** The work on its way from one figure to the next: a glowing gold bead. */
  private readonly bead = new Object3D()
  private readonly floor: Mesh<PlaneGeometry, ShadowMaterial>
  /** The light their shadows come from: the page's lamp, hung where its bulb is (hangKey()). */
  private readonly key = new SpotLight('#FFF3E2', 2.3, 0, Math.PI / 4, 0, 0)
  /** Where the bulb is, in this canvas's CSS pixels; null until the page says (lamp()). */
  private bulb: Vector2 | null = null
  /** What the key light has to reach: the crew and its thread, as fit() frames them. */
  private reach: Vector3[] = []
  /** The canvas's width in device pixels, which the floor's shadows fade out toward the sides of. */
  private readonly stageWidth = { value: 1 }
  private readonly glow: CrewGlow
  /** Each state's glow colour, the page's own (glowColors()); these are its dark theme's. */
  private colors: Record<Glow, Vector4> = { ready: glowColor('#4FC98D'), working: glowColor('#6AB8FF'), waiting: glowColor('#E9C46A') }

  constructor(canvas: HTMLCanvasElement, members: readonly CrewMember[], callbacks: CrewCallbacks, reduced: boolean) {
    this.members = members
    this.callbacks = callbacks
    this.reduced = reduced
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' })
    this.renderer.setClearColor(0x000000, 0)
    // The glow is laid on the cleared canvas first, and the scene drawn over it.
    this.renderer.autoClear = false
    this.renderer.toneMapping = NeutralToneMapping
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = PCFShadowMap

    this.scene.add(new HemisphereLight('#FFF6E8', '#2A2A32', 0.75))
    // A spotlight with no falloff, so it lights them all alike, but each from where the bulb is.
    const key = this.key
    key.castShadow = true
    key.shadow.mapSize.set(1024, 1024)
    key.shadow.camera.near = 0.5
    key.shadow.camera.far = 30
    key.shadow.bias = -0.0004
    key.shadow.normalBias = 0.02
    key.shadow.radius = 4
    this.scene.add(key, key.target)
    const rim = new DirectionalLight('#DDE6FF', 1.0)
    rim.position.set(-2.5, 2.2, -2.5)
    this.scene.add(rim)

    const floorGeometry = new PlaneGeometry(14, 8)
    const floorMaterial = new ShadowMaterial({ opacity: SHADOW })
    // A long shadow fades out toward the canvas's sides rather than stopping at its edge.
    floorMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.stageWidth = this.stageWidth
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', 'uniform float stageWidth;\nvoid main() {')
        .replace('opacity * ( 1.0 - getShadowMask() )', 'opacity * ( 1.0 - getShadowMask() ) * smoothstep( 0.0, 0.1, min( gl_FragCoord.x, stageWidth - gl_FragCoord.x ) / stageWidth )')
    }
    const floor = new Mesh(floorGeometry, floorMaterial)
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    this.scene.add(floor)
    this.floor = floor
    this.disposables.push(floorGeometry, floorMaterial)
    this.glow = this.own(new CrewGlow(this.renderer, 0.9))
  }

  /** Build the crew from workbench.glb: its URL, or its bytes when the page has fetched them already. */
  async load(model: string | ArrayBuffer): Promise<void> {
    // The room it is lit by: made here rather than with its WebGL context, so a page that loads it a
    // moment after making it (main.js) waits on one of the two at a time.
    this.scene.environment = await roomEnvironment(this.renderer, 0.04)
    this.scene.environmentIntensity = 0.55

    const gltf = await readModel(model)
    const source = gltf.scene.getObjectByName('figure')
    if (!source) throw new Error('The model has no figure.')
    source.removeFromParent()
    source.position.set(0, 0, 0)
    source.updateMatrixWorld(true)
    const box = new Box3().setFromObject(source, true)
    this.standY = -box.min.y
    const wound = this.own(woundTexture())
    this.members.forEach((member, index) => {
      const root = source.clone(true)
      const meshes = dressFigure(root, member, wound, (item) => this.own(item))
      for (const mesh of meshes) {
        const role = mesh.userData.role as string
        mesh.castShadow = role !== 'glint' && !mesh.name.endsWith('_face')
        mesh.receiveShadow = role !== 'glint'
        mesh.userData.member = index
        mesh.userData.material = mesh.material
      }
      const named = figurePart(root)
      const eyes = figureEyes(root)
      this.scene.add(root)
      this.figures.push({
        root, body: named('body'), neck: named('neck'), head: named('head'), armL: named('arm_l'), armR: named('arm_r'),
        handL: named('hand_l'), handR: named('hand_r'), eyes, meshes, tint: this.glow.material(), pose: { ...REST },
        nextBlink: 1.5 + ((index * 1.37) % 2.6), phase: index * 1.618, hop: -10,
      })
    })
    for (const geometry of new Set(this.figures.flatMap((figure) => figure.meshes.map((mesh) => mesh.geometry)))) this.disposables.push(geometry)
    source.traverse((object) => { if (object instanceof Mesh) (object.material as Material).dispose() })
    // Measured where it stands on the floor.
    this.headTop = new Box3().setFromObject(this.figures[0].root, true).max.y + this.standY
    this.threadMaterial = this.own(new MeshStandardMaterial({ color: '#E2B451', roughness: 0.32, metalness: 1, emissive: new Color('#E9C46A'), emissiveIntensity: 0.18 }))
    const beadGeometry = this.own(new SphereGeometry(0.032, 20, 14))
    const core = new Mesh(beadGeometry, this.own(new MeshStandardMaterial({ color: '#FFF1C9', roughness: 0.35, emissive: new Color('#F2C25B'), emissiveIntensity: 2.4 })))
    const halo = new Mesh(beadGeometry, this.own(new MeshBasicMaterial({ color: '#F5CF72', transparent: true, opacity: 0.32, blending: AdditiveBlending, depthWrite: false })))
    halo.scale.setScalar(2.6)
    this.bead.add(core, halo)
    this.bead.visible = false
    this.scene.add(this.bead)
    this.loaded = true
    this.layout()
    // Every shader the crew and its glow draw with, compiled before the first frame (readyToDraw).
    await Promise.all([readyToDraw(this.renderer, this.scene, this.camera), this.glow.compile(() => this.compileFlat())])
    this.ready = true
    this.frame()
    // Loaded once that frame is drawn: the page shows it then, and only then makes its other scenes.
    await drawn(this.renderer)
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
      const { curve, held } = this.threadCurve(row.map((index) => this.figures[index]))
      this.curves[r] = curve
      row.forEach((index, at) => { this.held[index] = { row: r, t: held[at] } })
      thread.geometry.dispose()
      thread.geometry = new TubeGeometry(curve, 40 * row.length, 0.012, 6)
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
    const over = this.pointer && this.ready ? this.pick(this.pointer.x, this.pointer.y) : null
    if (over !== this.hovered) {
      this.hovered = over
      this.callbacks.onHover(over)
    }
  }

  /** A click or tap at this point: the figure there, if any, is picked. */
  pointerUp(x: number, y: number) {
    const picked = this.ready ? this.pick(x, y) : null
    if (picked !== null) this.callbacks.onPick(picked)
  }

  /**
   * Play a conversation (crewTalk.ts) after `delay` seconds, `loops` times, from the start. It runs
   * on the scene's own clock, so it waits while the stage is off screen, while a figure is under
   * the pointer, and while it is paused. Reduced motion never plays it.
   */
  talk(script: readonly TalkLine[], { delay = 0, loops = 1 }: { delay?: number; loops?: number } = {}) {
    if (this.reduced) return
    this.script = script
    this.loops = loops
    this.talkClock = -delay
    this.talking = true
  }

  pauseTalk() {
    this.talking = false
  }

  /** The colour each state glows, as CSS colours: the page passes its theme's. */
  glowColors(colors: Record<Glow, string>) {
    this.colors = { ready: glowColor(colors.ready), working: glowColor(colors.working), waiting: glowColor(colors.waiting) }
    if (this.loaded && !this.running) this.frame()
  }

  playTalk() {
    if (this.script && !this.talkState?.done) this.talking = true
  }

  /**
   * The page's lamp: where its bulb is, in this canvas's CSS pixels (off the canvas, above it), and
   * whether it is lit. Their light hangs there, so each figure's shadow falls away from the bulb;
   * with the bulb off, the floor has no shadows. The page says as it scrolls, so a stopped scene,
   * which is off the screen, draws it when it starts again rather than now.
   */
  lamp(x: number, y: number, lit: boolean) {
    this.bulb = new Vector2(x, y)
    this.floor.material.opacity = lit ? SHADOW : 0
    if (this.loaded) this.hangKey()
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
    // Until its shaders are compiled (load()), a frame would wait for them: it only clears.
    if (!this.ready) {
      this.renderer.setRenderTarget(null)
      this.renderer.clear()
      return
    }
    this.glow.draw(() => this.drawFlat())
    this.renderer.render(this.scene, this.camera)
    this.callbacks.onFrame(this.figures.map((figure) => this.screen(figure.head.getWorldPosition(new Vector3()).setY(this.headTop + 0.04))), this.hovered === null ? this.talkState : null)
  }

  private update(dt: number) {
    const t = this.now
    const motion = this.reduced ? 0 : 1
    const hovered = this.hovered

    // The conversation waits while you point at one of them.
    if (this.script && this.talking && hovered === null) this.talkClock += dt
    const talk = this.script ? talkAt(this.script, this.talkClock, this.loops) : null
    if (talk?.done) this.talking = false
    // The one handed the work gives a little hop as it arrives.
    const passTo = talk?.pass?.to ?? null
    if (this.passTo !== null && passTo === null && talk?.speaker === this.passTo) this.figures[this.passTo].hop = t
    this.passTo = passTo
    this.talkState = talk
    const live = hovered === null && talk !== null && (talk.speaker !== null || talk.waiting) ? talk : null

    // Now and then one of them hops, or turns to look at its neighbour, while nobody points or talks.
    if (!this.reduced && t > this.nextFidget && hovered === null && !live) {
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
      const lookAt = (point: Vector3) => {
        const toward = point.clone().sub(head)
        target.lookX = MathUtils.clamp(toward.x / 0.9, -1, 1)
        target.lookY = MathUtils.clamp(toward.y / 0.6, -1, 1) - 0.1
      }
      if (hovered !== null && hovered !== index) {
        lookAt(this.figures[hovered].head.getWorldPosition(new Vector3()))
      } else if (live?.waiting) {
        // The work is yours now: they all look out at you.
        target.lookX = MathUtils.clamp(-figure.root.position.x * 0.22, -0.5, 0.5)
        target.lookY = 0.12
      } else if (live?.pass) {
        // Everyone watches the work go by.
        lookAt(this.bead.position)
      } else if (live && live.speaker !== null && live.speaker !== index) {
        lookAt(this.figures[live.speaker].head.getWorldPosition(new Vector3()))
      } else if (live && live.speaker === index) {
        if (live.bubble?.says === null) {
          // Thinking: it looks up and away.
          target.lookX = 0.35
          target.lookY = 0.38
        } else {
          if (typeof live.to === 'number') lookAt(this.figures[live.to].head.getWorldPosition(new Vector3()))
          // It bobs as it speaks, and holds still while paused.
          if (this.talking) target.bodyY += 0.01 * Math.abs(Math.sin(t * 9)) * motion
        }
      } else if (this.pointer && !this.reduced) {
        // Everyone looks where you point, each from where it stands.
        const at = this.screen(head)
        target.lookX = MathUtils.clamp((this.pointer.x - at.x) / (this.width * 0.45), -1, 1)
        target.lookY = MathUtils.clamp(-(this.pointer.y - at.y) / (this.height * 0.6), -1, 1)
      } else if (!this.reduced) {
        target.lookX = 0.3 * Math.sin(beat * 0.31) + 0.12 * Math.sin(beat * 0.87)
        target.lookY = 0.1 * Math.sin(beat * 0.43)
      }

      if (hovered === index || (live?.waiting && live.bubble?.by === index)) {
        // It lets go with its right mitten and waves at you: you pointed at it, or it waits for you.
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
    this.placeBead(talk)
    this.tint(talk, dt)
  }

  /** Each figure's glow eases to what it is doing; a working one breathes while the talk plays. */
  private tint(talk: TalkState | null, dt: number) {
    const glows = glowAt(talk, this.figures.length)
    const ease = this.reduced ? 1 : 1 - Math.exp(-dt * 6)
    const breath = this.talking && !this.reduced ? 0.5 - 0.5 * Math.cos((2 * Math.PI * this.now) / BREATH) : 1
    this.figures.forEach((figure, index) => {
      const glow = glows[index]
      const [low, high] = GLOW.working
      const strength = this.hovered === index ? GLOW.hovered : glow === 'working' ? low + (high - low) * breath : GLOW[glow]
      easeTint(figure.tint.uniforms.tint.value as Vector4, this.colors[glow], strength, ease)
    })
  }

  /** The figures alone, each flat in its glow's colour, for the glow to blur: no floor, thread or bead. */
  private drawFlat() {
    const shown = [this.floor, this.bead, ...this.threads].filter((object) => object.visible)
    for (const object of shown) object.visible = false
    for (const figure of this.figures) for (const mesh of figure.meshes) mesh.material = figure.tint
    // The shadows are the scene's, drawn once with it.
    this.renderer.shadowMap.autoUpdate = false
    this.renderer.render(this.scene, this.camera)
    this.renderer.shadowMap.autoUpdate = true
    for (const figure of this.figures) for (const mesh of figure.meshes) mesh.material = mesh.userData.material as Material
    for (const object of shown) object.visible = true
  }

  /** Compile a figure as drawFlat draws it, for the glow (CrewGlow.compile); they all draw alike. */
  private compileFlat(): Promise<unknown> {
    const figure = this.figures[0]
    for (const mesh of figure.meshes) mesh.material = figure.tint
    const compiled = readyToDraw(this.renderer, figure.root, this.camera, this.scene)
    for (const mesh of figure.meshes) mesh.material = mesh.userData.material as Material
    return compiled
  }

  /**
   * The bead runs along the thread between two figures in one row; between rows (on a phone, the
   * crew stands in two) it is tossed over the front row's heads.
   */
  private placeBead(talk: TalkState | null) {
    const pass = talk?.pass
    const from = pass ? this.held[pass.from] : undefined
    const to = pass ? this.held[pass.to] : undefined
    this.bead.visible = Boolean(pass && from && to && this.hovered === null)
    if (!pass || !from || !to) return
    const s = MathUtils.smootherstep(pass.at, 0, 1)
    if (from.row === to.row) this.bead.position.copy(this.curves[from.row].getPoint(MathUtils.lerp(from.t, to.t, s)))
    else {
      const start = this.curves[from.row].getPoint(from.t)
      const end = this.curves[to.row].getPoint(to.t)
      const lift = this.headTop + 0.15 - (start.y + end.y) / 2
      this.bead.position.copy(start).lerp(end, s).add(new Vector3(0, lift * Math.sin(Math.PI * s), 0))
    }
    this.bead.scale.setScalar(this.talking ? 1 + 0.18 * Math.sin(this.now * 14) : 1)
  }

  /**
   * Through every mitten that holds it, sagging between neighbours and trailing off at both ends.
   * `held` is where along it each figure holds it, between its two mittens.
   */
  private threadCurve(figures: readonly Figure[]): { curve: CatmullRomCurve3; held: number[] } {
    const points: Vector3[] = []
    const grips: number[] = []
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
      grips.push(points.length)
      points.push(waving ? left.clone().lerp(right, 0.5).add(new Vector3(0, -0.05, 0.05)) : right, left)
      if (index === figures.length - 1) points.push(left.clone().add(new Vector3(0.28, -0.07 + 0.01 * Math.sin(t * 1.1), 0.03)), left.clone().add(new Vector3(0.55, -0.12, 0.05)))
    })
    // A curve's t reaches its points evenly: point k is at k / (points - 1).
    return { curve: new CatmullRomCurve3(points, false, 'centripetal'), held: grips.map((k) => (k + 0.5) / (points.length - 1)) }
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
    this.camera.updateMatrixWorld()
    // The glow spreads with the figures' size on the screen: a twentieth of a front-row figure's height.
    const tall = this.screen(new Vector3(0, 0, front)).y - this.screen(new Vector3(0, this.headTop, front)).y
    const size = this.renderer.getDrawingBufferSize(new Vector2())
    this.glow.resize(size.x, size.y, tall * 0.05 * (size.x / this.width))
    this.stageWidth.value = size.x
    // The light reaches every figure and the thread's ends, a waving mitten over a head too.
    this.reach = [left, right].flatMap((x) => [back - 0.35, front + 0.35].flatMap((z) => [new Vector3(x, 0, z), new Vector3(x, this.headTop + 0.2, z)]))
    this.hangKey()
  }

  /**
   * Hang the key light where the bulb is: from the crew toward the point on the line from the camera
   * through the bulb a little in front of them (LAMP), so the light and the shadows come from where
   * you see the bulb. Its cone just takes in the crew, which keeps the shadows as sharp as its map
   * allows.
   */
  private hangKey() {
    // Until the page says where the bulb is: up and to the right, as it is in the page's header.
    const bulb = this.bulb ?? new Vector2(this.width * 0.9, -this.height * 1.5)
    const camera = this.camera.position
    const ray = new Vector3((bulb.x / this.width) * 2 - 1, 1 - (bulb.y / this.height) * 2, 0.5).unproject(this.camera).sub(camera).normalize()
    const forward = this.camera.getWorldDirection(new Vector3())
    const middle = this.reach.reduce((sum, point) => sum.add(point), new Vector3()).divideScalar(this.reach.length)
    const depth = forward.dot(middle.clone().sub(camera)) * LAMP.depth
    const key = this.key
    key.position.copy(camera).addScaledVector(ray, depth / Math.max(0.05, ray.dot(forward))).sub(middle).multiplyScalar(LAMP.out).add(middle)
    // Aimed down the middle of what it has to reach, and just wide enough for all of it.
    const toward = this.reach.map((point) => point.clone().sub(key.position).normalize())
    const aim = toward.reduce((sum, direction) => sum.add(direction), new Vector3()).normalize()
    key.angle = Math.min(1.45, Math.max(...toward.map((direction) => aim.angleTo(direction))) + 0.06)
    key.target.position.copy(key.position).add(aim)
    key.updateMatrixWorld()
    key.target.updateMatrixWorld()
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

/**
 * Dress a clone of the model's figure as one member: the bench's materials, its skin in its colour,
 * and only its own head showing. Each mesh keeps the role Blender
 * named its material in `userData.role`. Whatever it makes is handed to `own` to dispose of.
 */
export function dressFigure(root: Object3D, member: CrewMember, wound: Texture, own: <T extends { dispose: () => void }>(item: T) => T): Mesh[] {
  const meshes: Mesh[] = []
  const pegboard = () => own(pegboardTexture())
  const skin = new Color(COLOR_HEX[member.figure.color])
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return
    const role = (object.material as Material).name
    const material = own(benchMaterial(role, object.name, { pegboard, wound }))
    if (role === 'skin' || role === 'skin_wound') (material as MeshStandardMaterial).color.copy(skin)
    if (role === 'skin_deep') (material as MeshStandardMaterial).color.copy(skin).multiplyScalar(0.86)
    object.material = material
    object.userData.role = role
    meshes.push(object)
  })
  const named = figurePart(root)
  for (const kind of FIGURE_KINDS) named(`head_${kind}`).visible = kind === member.figure.kind
  return meshes
}

/** A named part of a figure, which the model must have. */
export function figurePart(root: Object3D): (name: string) => Object3D {
  return (name) => {
    const found = root.getObjectByName(name)
    if (!found) throw new Error(`The figure has no “${name}”.`)
    return found
  }
}

/** Every eye on a figure, the hidden heads' too: a blink squashes them all. */
export function figureEyes(root: Object3D): Object3D[] {
  const eyes: Object3D[] = []
  root.traverse((object) => { if (/_eye_[lr]$/.test(object.name)) eyes.push(object) })
  return eyes
}

