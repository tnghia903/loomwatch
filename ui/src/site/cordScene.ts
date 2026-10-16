import {
  Box3,
  DirectionalLight,
  HemisphereLight,
  MathUtils,
  NeutralToneMapping,
  Object3D,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

import { fitCanvas, readModel, readyToDraw } from '../components/agents/workbenchModel'
import { woundTexture } from '../components/agents/benchTextures'
import { dressFigure, figureEyes, figurePart, type CrewMember } from './crewScene'

/** How the page's cord is moving this frame, for the figure hanging on it to answer. */
export interface CordMotion {
  /** How fast the cord swings, in radians a second, clockwise on screen. */
  swing: number
  /** How far it is pulled down, from 0 (hanging) to 1 (all the way). */
  pull: number
  /** The pointer, in this canvas's CSS pixels as it hangs upright, or null. */
  pointer: { x: number; y: number } | null
  /** The pointer is on the figure, or holding it. */
  near: boolean
}

/** Dangling: mittens down and a little out. */
const HANG = { armLRX: -0.12, armLRZ: 0.34, armRRX: -0.12, armRRZ: -0.34, lookX: 0, lookY: 0, wave: 0 }
type Pose = typeof HANG

/**
 * The landing page's pull cord: one of the crew (crewScene.ts) hanging from the theme button's gold
 * thread by a loop on top of its head. The page swings the cord; this draws the figure on it and
 * answers the swing: its mittens trail behind, it turns slowly on the thread, looks at you when you
 * come near and waves, throws its arms up when pulled, and screws its eyes shut when the light
 * changes. Reduced motion keeps the hang and the looks and drops the rest.
 */
export class CordScene {
  private readonly renderer: WebGLRenderer
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(20, 1, 0.1, 40)
  private readonly member: CrewMember
  private readonly reduced: boolean
  private readonly disposables: { dispose: () => void }[] = []
  private width = 1
  private height = 1
  private loaded = false
  private now = 0
  private pose: Pose = { ...HANG }
  private root: Object3D | null = null
  private parts: { neck: Object3D; head: Object3D; armL: Object3D; armR: Object3D; handR: Object3D; eyes: Object3D[] } | null = null
  /** Where the thread is tied: the top of its head. */
  private readonly tie = new Object3D()
  private readonly box = new Box3()
  /** It turns on the thread: how far, and how fast. */
  private twist = 0
  private twistSpeed = 0
  private nextBlink = 1.6
  private shutUntil = -1

  constructor(canvas: HTMLCanvasElement, member: CrewMember, reduced: boolean) {
    this.member = member
    this.reduced = reduced
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' })
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.toneMapping = NeutralToneMapping

    // Lit as the crew is, without the floor and its shadows.
    const pmrem = new PMREMGenerator(this.renderer)
    const room = new RoomEnvironment()
    this.scene.environment = pmrem.fromScene(room, 0.04).texture
    this.scene.environmentIntensity = 0.55
    room.dispose()
    pmrem.dispose()
    this.scene.add(new HemisphereLight('#FFF6E8', '#2A2A32', 0.75))
    const key = new DirectionalLight('#FFF3E2', 2.3)
    key.position.set(-1.6, 4.2, 3.4)
    const rim = new DirectionalLight('#DDE6FF', 1.0)
    rim.position.set(2.5, 2.2, -2.5)
    this.scene.add(key, rim)
  }

  /** Build the figure from workbench.glb: its URL, or its bytes when the page has fetched them already. */
  async load(model: string | ArrayBuffer): Promise<void> {
    const gltf = await readModel(model)
    const root = gltf.scene.getObjectByName('figure')
    if (!root) throw new Error('The model has no figure.')
    root.removeFromParent()
    root.position.set(0, 0, 0)
    const own = <T extends { dispose: () => void }>(item: T): T => { this.disposables.push(item); return item }
    const meshes = dressFigure(root, this.member, own(woundTexture()), own)
    for (const geometry of new Set(meshes.map((mesh) => mesh.geometry))) this.disposables.push(geometry)
    const named = figurePart(root)
    const head = named('head')
    this.parts = { neck: named('neck'), head, armL: named('arm_l'), armR: named('arm_r'), handR: named('hand_r'), eyes: figureEyes(root) }

    // Tie the thread to the top of the head it wears, and hang the figure from it.
    root.updateMatrixWorld(true)
    const crown = new Box3().setFromObject(named(`head_${this.member.figure.kind}`), true)
    head.add(this.tie)
    this.tie.position.copy(head.worldToLocal(new Vector3((crown.min.x + crown.max.x) / 2, crown.max.y, (crown.min.z + crown.max.z) / 2)))
    root.position.y = -crown.max.y
    this.scene.add(root)
    this.root = root
    root.updateMatrixWorld(true)
    this.box.setFromObject(root, true)
    // Its shaders compiled before the page draws it (readyToDraw).
    await readyToDraw(this.renderer, this.scene, this.camera)
    this.loaded = true
    this.fit()
  }

  resize(width: number, height: number) {
    const size = fitCanvas(this.renderer, width, height)
    this.width = size.width
    this.height = size.height
    this.camera.aspect = this.width / this.height
    this.fit()
  }

  /** The light just changed: it screws its eyes shut for a moment. */
  flinch() {
    this.shutUntil = this.now + 0.45
  }

  /** Let go after a pull: it spins on the thread, this fast (radians a second) and this way. */
  spin(speed: number) {
    if (!this.reduced) this.twistSpeed += speed
  }

  /**
   * Move it on by dt seconds and draw it. Returns where its thread is tied, in this canvas's CSS
   * pixels as it hangs upright, so the page can hang the canvas from the end of the cord.
   */
  draw(dt: number, motion: CordMotion): { x: number; y: number } {
    this.now += dt
    if (this.loaded && this.root && this.parts) this.update(dt, motion, this.root, this.parts)
    this.renderer.render(this.scene, this.camera)
    return this.screen(this.tie.getWorldPosition(new Vector3()))
  }

  dispose() {
    for (const item of this.disposables) item.dispose()
    this.scene.environment?.dispose()
    this.renderer.dispose()
  }

  private update(dt: number, motion: CordMotion, root: Object3D, parts: NonNullable<CordScene['parts']>) {
    const t = this.now
    const still = this.reduced ? 0 : 1
    const target: Pose = { ...HANG }

    // The mittens trail the swing, and fly up the further it is pulled.
    const trail = MathUtils.clamp(motion.swing * 0.16, -0.9, 0.9) * still
    const up = MathUtils.smoothstep(motion.pull, 0, 1)
    target.armLRZ = MathUtils.lerp(HANG.armLRZ, 2.5, up) + trail + 0.05 * Math.sin(t * 1.3) * still
    target.armRRZ = MathUtils.lerp(HANG.armRRZ, -2.5, up) + trail + 0.05 * Math.sin(t * 1.3 + 1.7) * still

    if (motion.pointer) {
      const at = this.screen(parts.head.getWorldPosition(new Vector3()))
      target.lookX = MathUtils.clamp((motion.pointer.x - at.x) / 220, -1, 1)
      target.lookY = MathUtils.clamp(-(motion.pointer.y - at.y) / 160, -1, 1)
    } else if (still) {
      target.lookX = 0.35 * Math.sin(t * 0.29)
      target.lookY = -0.15 + 0.1 * Math.sin(t * 0.41)
    }
    if (motion.near && motion.pull < 0.05) {
      // Come near and it waves with its right mitten, as the crew does.
      target.wave = 1
      target.armRRX = -0.25
      target.armRRZ = -2.45 + 0.28 * Math.sin(t * 8) * still
    }

    // It turns on the thread: toward you when you are near, otherwise slowly to and fro.
    const facing = motion.near || motion.pointer ? 0 : 0.55 * Math.sin(t * 0.37) * still
    this.twistSpeed += (-(this.twist - facing) * 9 - this.twistSpeed * (this.reduced ? 12 : 1.6)) * dt
    this.twist += this.twistSpeed * dt
    root.rotation.y = this.twist

    const ease = this.reduced ? 1 : 1 - Math.exp(-dt * 9)
    for (const channel of Object.keys(target) as (keyof Pose)[]) this.pose[channel] += (target[channel] - this.pose[channel]) * ease
    const p = this.pose
    parts.neck.rotation.set(-p.lookY * 0.05, 0, -p.lookX * 0.06)
    parts.head.rotation.set(-p.lookY * 0.24, p.lookX * 0.5, 0)
    parts.armL.rotation.set(p.armLRX, 0, p.armLRZ)
    parts.armR.rotation.set(p.armRRX, 0, p.armRRZ)
    parts.handR.rotation.x = -0.3 * p.wave
    this.blink(parts.eyes)
    root.updateMatrixWorld(true)
  }

  private blink(eyes: Object3D[]) {
    let shut = 1
    if (this.now < this.shutUntil) shut = 0.1
    else if (!this.reduced) {
      const since = this.now - this.nextBlink
      shut = since < 0 ? 1 : since < 0.14 ? 0.12 + 0.88 * Math.abs(since / 0.07 - 1) : 1
      if (since >= 0.14) this.nextBlink = this.now + 2.4 + ((this.now * 7.13) % 3.4)
    }
    for (const eye of eyes) eye.scale.y = shut
  }

  /** Frame the hanging figure, a little from above so the thread's loop shows, with room for its mittens. */
  private fit() {
    if (!this.loaded) return
    const size = this.box.getSize(new Vector3())
    const target = this.box.getCenter(new Vector3())
    const direction = new Vector3(0, 0.22, 1).normalize()
    const half = Math.max(size.x * 0.62, size.y * 0.5 * this.camera.aspect) + 0.04
    this.camera.updateProjectionMatrix()
    const across = Math.tan(MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect
    this.camera.position.copy(target).addScaledVector(direction, half / across / 0.78)
    this.camera.lookAt(target)
    this.camera.updateProjectionMatrix()
  }

  private screen(point: Vector3) {
    this.camera.updateMatrixWorld()
    const projected = point.clone().project(this.camera)
    return { x: ((projected.x + 1) / 2) * this.width, y: ((1 - projected.y) / 2) * this.height }
  }
}
