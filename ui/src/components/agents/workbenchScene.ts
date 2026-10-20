import {
  Box3,
  BoxGeometry,
  Color,
  DirectionalLight,
  ExtrudeGeometry,
  Group,
  HemisphereLight,
  MathUtils,
  Mesh,
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
  Shape,
  ShapeGeometry,
  SphereGeometry,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
} from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

import { BUSY, BUSY_SECONDS, CARD_SLOTS, FIGURE_KEYS, nextBusy, partOfNode, reactionsBetween, READ_SLOTS, TOOL_SLOTS, type BenchUse, type BusyKind, type FigureLook, type FigureMood, type FigurePart, type FigureReaction, type ReadSource, type WorkPhase } from '../../lib/library/figure'
import { COLOR_HEX, FIGURE_KINDS, wornBy, type FigureChoice, type FigureKind } from '../../lib/library/figures'
import type { AllowSwitch } from '../../lib/team-file/types'
import { dress, type Dressed } from './accessoryMeshes'
import { cardTexture, keyLabelTexture, pegboardTexture, toolTexture, woundTexture } from './benchTextures'
import { benchMaterial, fitCanvas, LIVE, readModel, readyToDraw } from './workbenchModel'

/** Everything the bench shows, from the agent on screen and the run in its chat. */
export interface BenchView {
  look: FigureLook
  /** The figure it wears: which head, and the colour of its skin. */
  figure: FigureChoice
  does: string
  appName: string
  hasReply: boolean
  mood: FigureMood
  /** Recorded events in the run so far: each one flickers its screen. */
  events: number
  /**
   * What its agent is at while the run is live (WorkPhase, from the run's events): reading its
   * message, thinking, using a tool or typing. It acts that out a few ways in turn (BUSY), so it is
   * never still while it works. Left out, as the landing page's bench leaves it, it types while
   * events arrive and rests its hands on the keys while they don't.
   */
  phase?: WorkPhase
  /**
   * What its model is thinking about while it thinks, in a few words from its reasoning
   * (thoughtLine), for the comic bubble AgentFigure lays over its head; null when it hasn't said.
   */
  thought?: string | null
  /**
   * What its agent just used from the bench (BenchUse): a skill, a folder it reads, a tool. It goes
   * and gets each one, and carries it back to the desk. Left out, as on the landing page, it stays.
   */
  uses?: readonly BenchUse[]
  asked: AllowSwitch | null
  open: FigurePart | null
  /** A skill card is being dragged over the bench. */
  dropping: boolean
  /**
   * What it reads, filed in the bench's file drawer: what it is given in its builder, and in a team
   * what that team gives it besides. With nothing the drawer stays shut; the landing page's bench
   * has no drawer.
   */
  reads?: readonly ReadSource[] | null
  /**
   * The tools (MCP servers) it is given, a tile with each one's icon standing in the bench's tool
   * drawer. Every agent you build has one, in Your agents and in a team; the landing page's bench
   * has none.
   */
  tools?: readonly BenchTool[] | null
  /**
   * The helpers its agent brought in for this run (ADR 0079): each a smaller copy of the figure, at
   * a laptop of its own on the bench, acting out what its own events say it is at with the same
   * logic as the figure (actOut). One that finished stays a moment, then goes. Left out, as on the
   * landing page, there are none.
   */
  helpers?: readonly BenchHelper[]
}

/** A helper at the bench: who, what it is at while it works (WorkPhase), and how it ended. */
export interface BenchHelper {
  id: string
  phase: WorkPhase | null
  state: 'working' | 'done' | 'failed'
}

/** A tool in the drawer: its name, and the icon LoomWatch serves for it once it is connected. */
export interface BenchTool {
  name: string
  icon: string | null
}

export type BenchAnchor = 'mind' | 'app' | 'name' | 'job' | 'skills' | 'reads' | 'tools' | 'keys' | 'dish' | 'reply' | 'thought'
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

/** How the app's bench differs from the landing page's, which keeps the bench as it was drawn. */
export interface BenchOptions {
  /**
   * Hang the job's clipboard on the pegboard, under the key hooks, rather than standing it on the
   * bench: the back of the bench is where helpers sit (ADR 0079), and a clipboard in front of
   * them hides them.
   */
  clipboardOnBoard?: boolean
}

/**
 * Where the clipboard hangs on the pegboard, in the pegboard's own space: under the key hooks on
 * its left, clear of the skill cards on its right and of the figure's head in the middle. Its
 * origin is the clipboard's bottom edge; it is drawn this much smaller than on the bench.
 */
const CLIPBOARD_ON_BOARD = { x: -0.68, y: -0.41, z: 0.03, size: 0.78 }

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
/**
 * The bench's two drawers, either side of the nameplate, hold what it works with: what it reads on
 * the left and its tools on the right, each given in its builder or with a line in Workflow. Its keys and skills hang on the wall, and the work (the job, the laptop,
 * the tray) is on top. `front` is the bench's front face; open, a drawer slides out past the bench
 * top's overhang so what is in it shows, and with nothing in it, it stays shut.
 */
const DRAWER = { bottom: 0.27, width: 0.42, height: 0.18, depth: 0.32, front: 0.26, open: 0.28 }
type DrawerName = 'reads' | 'tools'
const DRAWER_X: Record<DrawerName, number> = { reads: -0.7, tools: 0.7 }
/**
 * The tool drawer is lined with foam, flush with its sides, and each tool stands in it as a tile
 * with its icon, in a row across the drawer: bigger the fewer there are, so one or two read at a
 * glance. A tile is made `TOOL_TILE` high and scaled to its size, by how many there are.
 */
const TOOL_FOAM = 0.135
const TOOL_TILE = 0.1
/** How big a tile is with one to four in the drawer. */
const TOOL_SIZES = [0.115, 0.105, 0.092, 0.08]
/** Where a tool's tile stands, and how big it is, with `count` in the drawer. */
function toolPlace(slot: number, count: number): { at: Vector3; scale: number } {
  const shown = MathUtils.clamp(count, 1, TOOL_SLOTS)
  const size = TOOL_SIZES[shown - 1]
  // Standing on the foam, so the whole tile shows over the drawer's front.
  return { at: new Vector3((slot - (shown - 1) / 2) * (size + 0.014), TOOL_FOAM + 0.002, -0.07), scale: size / TOOL_TILE }
}
/** Where each folder is filed, front first, and where each tool's tile stands with the drawer full. */
const DRAWER_SLOTS: Record<DrawerName, Vector3[]> = {
  reads: Array.from({ length: READ_SLOTS }, (_, slot) => new Vector3(0, 0.016, -0.035 - slot * 0.042)),
  tools: Array.from({ length: TOOL_SLOTS }, (_, slot) => toolPlace(slot, TOOL_SLOTS).at),
}
const FOLDER_TINTS = ['#E6CD97', '#DCC08A', '#E9D5AA', '#D9BC80']
/**
 * What is in a drawer sits under the bench top, in its shade: its folders, sheets and tool tiles are
 * darkened by this much (in linear light), so they don't outshine the work on top.
 */
const DRAWER_SHADE = 0.4
const HIGHLIGHT = new Color('#E9C46A')
/** It looks with its head; its body turns only a little, so both hands stay on the laptop. */
const BODY_TURN = 0.12
/** How far its head turns and nods to look at something. */
const HEAD_TURN = 0.5
const HEAD_NOD = 0.24

/** The figure's pose, as offsets the frame eases toward. Arms at rest reach out to the laptop. */
const REST = { bodyY: 0, bodyRX: 0, bodyRY: 0, neckRX: 0, neckRZ: 0, lookX: 0, lookY: -0.3, armLRX: -1.42, armLRZ: -0.05, armRRX: -1.42, armRRZ: 0.05, scale: 1, band: 0, screen: 0.12, typing: 0, hands: 0, click: 0 }
type Pose = typeof REST
type Channel = keyof Pose

interface Action { kind: string; start: number; duration: number; side?: number }
/** What it does now while it works, and what it does next once that is decided. */
interface Busy { kind: BusyKind; start: number; duration: number; next: BusyKind | null }
/**
 * A trip from the desk to something it uses on the bench (BenchUse) and back: the thing, where it
 * lives, and the way there from the desk, which it comes back along.
 */
interface Trip {
  item: Object3D
  home: { parent: Object3D; p: Vector3; q: Quaternion; s: number }
  /** Whether the thing is still the bench's, so one taken off the bench meanwhile isn't put back. */
  still: () => boolean
  path: Vector3[]
  length: number
  /** Which way it faces there, how high it hops to reach, whether it reaches up (the pegboard) or down (a drawer), and the thing's size in its hand. */
  face: number
  hop: number
  reach: 'up' | 'down'
  held: number
  start: number
  /** Seconds going, reaching, coming back, and looking at it at the desk. */
  legs: readonly [number, number, number, number]
  picked: boolean
  returned: boolean
}
/** How fast it goes, in metres a second; how long it takes to reach a thing; how long it looks at it at the desk. */
const STRIDE = 1.1
const REACH_S = 1.5
const LOOK_S = 1.6
/** Where it stands to reach into a drawer: past the bench's end, and on the floor in front. */
const BENCH_END = 1.2
const FLOOR_Y = 0.12
const UP = new Vector3(0, 1, 0)
/** How far above the top of its head (and what it wears there) its thought bubble starts. */
const THOUGHT_GAP = 0.06
/**
 * Where helpers sit (ADR 0079): along the back of the bench top, either side of the figure's
 * laptop, nearest first, clear of the job sheet, the tray and your dish. Each is where its laptop
 * goes; its figure sits behind it, as the bench's figure sits behind its own. A helper past the
 * last seat works without one at the bench, and is still in the chat.
 */
const HELPER_SEATS: readonly { x: number; z: number }[] = [{ x: 0.5, z: -0.19 }, { x: -0.5, z: -0.19 }, { x: 0.84, z: -0.19 }, { x: -0.84, z: -0.24 }]
/** A helper is the figure at this size, laptop and all. */
const HELPER_SIZE = 0.5
/** Seconds a helper takes to come in, and to go. */
const HELPER_IN = 0.45
const HELPER_OUT = 0.35

/** A helper at the bench: its copy of the figure and of the laptop, and its own acting, pose and eyes. */
interface Seat {
  id: string
  slot: number
  group: Group
  rig: Rig
  lid: Object3D
  eyes: Object3D[]
  screen: MeshStandardMaterial
  band: MeshStandardMaterial
  acting: Acting
  pose: Pose
  nextBlink: number
  born: number
  /** When it began to go: it finished and left the view, or the figure it copied changed. */
  going: number | null
  /** When it finished, for the nod it gives as it hands its part back. */
  finished: number | null
}
interface Tween { node: Object3D; fromP: Vector3; toP: Vector3; fromQ: Quaternion; toQ: Quaternion; fromS: number; toS: number; start: number; duration: number; arc: number; done?: () => void }

const smooth = (edge0: number, edge1: number, x: number) => MathUtils.smoothstep(x, edge0, edge1)
const shown = (object: Object3D | null): boolean => { for (let at = object; at; at = at.parent) if (!at.visible) return false; return true }
const envelope = (u: number) => smooth(0, 0.18, u) * (1 - smooth(0.72, 1, u))
const bump = (u: number) => Math.sin(Math.PI * MathUtils.clamp(u, 0, 1))

/** Typing: its mittens tap the keys in turn (mittens()), its arms bob a little with them, by `amount`. */
function typeAway(target: Pose, t: number, amount: number) {
  const tap = (phase: number) => Math.max(0, Math.sin(t * 7.5 + phase)) * (0.65 + 0.35 * Math.sin(t * 2.3 + phase))
  target.typing = MathUtils.lerp(target.typing, 1, amount)
  target.armLRX -= 0.05 * tap(0) * amount
  target.armRRX -= 0.05 * tap(Math.PI) * amount
  target.armLRZ += 0.05 * Math.sin(t * 4.1) * amount
  target.armRRZ += 0.05 * Math.sin(t * 3.3 + 1) * amount
  target.bodyY += 0.003 * Math.abs(Math.sin(t * 15)) * amount
}

/** Where `distance` along a path is, and which way it heads there (a turn about the vertical, 0 facing +z). */
function alongPath(path: readonly Vector3[], distance: number): { point: Vector3; heading: number } {
  let left = Math.max(0, distance)
  for (let index = 1; index < path.length; index += 1) {
    const from = path[index - 1]
    const to = path[index]
    const span = from.distanceTo(to)
    const flat = Math.hypot(to.x - from.x, to.z - from.z)
    if (left <= span || index === path.length - 1) {
      const point = from.clone().lerp(to, span > 0 ? Math.min(1, left / span) : 1)
      return { point, heading: flat > 0.001 ? Math.atan2(to.x - from.x, to.z - from.z) : 0 }
    }
    left -= span
  }
  return { point: path[0].clone(), heading: 0 }
}

/** An action that starts now, or `under` of the way through it already, for as long as its kind lasts. */
function startBusy(kind: BusyKind, now: number, under = 0): Busy {
  const [low, high] = BUSY_SECONDS[kind]
  const duration = low + (high - low) * Math.random()
  return { kind, start: now - under * duration, duration, next: null }
}

/** The parts of a figure a pose moves: the bench's own figure, or a helper's smaller copy of it (ADR 0079). */
interface Rig { body: Object3D; neck: Object3D; head: Object3D; armL: Object3D; armR: Object3D; handL: Object3D; handR: Object3D }

/** A figure's parts, found in `root` (its `figure` node) by the model's names. */
function rigOf(root: Object3D): Rig {
  const part = (name: string) => {
    const found = root.getObjectByName(name)
    if (!found) throw new Error(`The figure has no “${name}”.`)
    return found
  }
  return { body: part('body'), neck: part('neck'), head: part('head'), armL: part('arm_l'), armR: part('arm_r'), handL: part('hand_l'), handR: part('hand_r') }
}

/** What a figure is at while it works, kept from frame to frame: its action, and its screen's flashes. */
interface Acting { busy: Busy | null; flash: number; nextFlash: number }

/** Where a figure's acting looks: its own screen, the job sheet, and its own head (to look above it). */
interface Places { screen: () => Vector3; job: () => Vector3; head: () => Vector3 }

/**
 * Looking at a point: its head turns and nods toward it, and its body turns a little. `turned` is
 * which way the figure faces (a turn about the vertical): away from the desk it may face another
 * way, and where to look is turned with it.
 */
function lookToward(rig: Rig, target: Pose, look: Vector3 | 'viewer' | null, viewer: Vector3, turned: number) {
  if (!look) {
    target.bodyRY = target.lookX * BODY_TURN
    return
  }
  const head = rig.head.getWorldPosition(new Vector3())
  const point = look === 'viewer' ? viewer.clone() : look.clone()
  const toward = point.sub(head)
  if (turned !== 0) toward.applyAxisAngle(UP, -turned)
  const behind = toward.z < -0.1
  target.lookX = MathUtils.clamp(toward.x / 0.75, -1, 1)
  target.lookY = MathUtils.clamp(toward.y / 0.6, -1, 1)
  target.bodyRY = MathUtils.clamp((behind ? -toward.x : toward.x) * 0.25, -BODY_TURN, BODY_TURN)
}

/**
 * Put a figure in pose `p`: its body, neck, head and arms, and its mittens — while it types each
 * taps on its own beat, open when it waves or stretches, the right one clicking the trackpad while
 * it uses a tool.
 */
function posed(rig: Rig, p: Pose, t: number, motion: number) {
  rig.body.position.y = p.bodyY
  rig.body.rotation.set(p.bodyRX, p.bodyRY, 0)
  rig.neck.rotation.set(p.neckRX - p.lookY * 0.05, 0, p.neckRZ - p.lookX * 0.06)
  rig.head.rotation.set(-p.lookY * HEAD_NOD, p.lookX * HEAD_TURN, 0)
  rig.head.scale.setScalar(p.scale)
  rig.armL.rotation.set(p.armLRX, 0, p.armLRZ)
  rig.armR.rotation.set(p.armRRX, 0, p.armRRZ)
  for (const [hand, phase, right] of [[rig.handL, 0, false], [rig.handR, 1.9, true]] as const) {
    const tap = Math.max(0, Math.sin(t * 11 + phase)) ** 3
    hand.rotation.x = p.hands + p.typing * 0.35 * tap * motion + (right ? p.click * 0.45 : 0)
  }
}

/** Shut `eyes` for a blink when it is time, and say when the next one is. */
function blinked(eyes: readonly Object3D[], now: number, next: number): number {
  const since = now - next
  const shut = since < 0 ? 1 : since < 0.14 ? 0.12 + 0.88 * Math.abs(since / 0.07 - 1) : 1
  for (const eye of eyes) eye.scale.y = shut
  return since >= 0.14 ? now + 2.6 + ((now * 7.13) % 3.4) : next
}

/** A square `size` across with rounded corners, standing on its bottom edge, its middle at x = 0. */
function roundedSquare(size: number, radius: number): Shape {
  const half = size / 2
  const shape = new Shape()
  shape.moveTo(-half + radius, 0)
  shape.lineTo(half - radius, 0)
  shape.absarc(half - radius, radius, radius, -Math.PI / 2, 0, false)
  shape.lineTo(half, size - radius)
  shape.absarc(half - radius, size - radius, radius, 0, Math.PI / 2, false)
  shape.lineTo(-half + radius, size)
  shape.absarc(-half + radius, size - radius, radius, Math.PI / 2, Math.PI, false)
  shape.lineTo(-half, radius)
  shape.absarc(-half + radius, radius, radius, Math.PI, Math.PI * 1.5, false)
  return shape
}

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
 * What a figure does while it works, in `phase`: the screen that goes with it, and one short
 * action after another (BUSY), each easing in and out of the hands-on-the-keys pose. It returns
 * where it looks. Reduced motion keeps the pose still: hands on the keys, eyes on the screen; so
 * does being `away` from the desk on a trip. The bench's own figure and each helper's smaller copy
 * of it act out their work with this, each with its own `acting` (ADR 0079).
 */
function actOut(phase: WorkPhase, acting: Acting, target: Pose, t: number, { reduced, away }: { reduced: boolean; away: boolean }, look: Vector3 | 'viewer', places: Places): Vector3 | 'viewer' {
  const screen = places.screen
  switch (phase) {
    case 'reading': target.screen = 0.6; break
    // Thinking, it looks away from a dimmer screen (AgentFigure shows its thought bubble).
    case 'thinking': target.screen = 0.3; break
    case 'tools':
      // Using the computer: its screen flashes as pages and results come up.
      target.screen = 0.9
      if (!reduced && t >= acting.nextFlash) {
        acting.flash = Math.max(acting.flash, 0.55 + 0.45 * Math.random())
        acting.nextFlash = t + 0.22 + 0.7 * Math.random()
      }
      break
    case 'typing': break
  }
  if (reduced || away) { acting.busy = null; return look }

  // One action after another. One that carries on (typing, reading) runs on without easing out.
  const fits = (kind: BusyKind | null) => BUSY[phase].some((item) => item.kind === kind)
  let busy = acting.busy
  if (!busy || !fits(busy.kind)) busy = acting.busy = startBusy(nextBusy(phase, busy?.kind ?? null, Math.random()), t)
  else if (t >= busy.start + busy.duration) busy = acting.busy = startBusy(busy.next && fits(busy.next) ? busy.next : nextBusy(phase, busy.kind, Math.random()), t)
  else if (!busy.next && t >= busy.start + busy.duration * 0.7) {
    busy.next = nextBusy(phase, busy.kind, Math.random())
    if (busy.next === busy.kind) busy = acting.busy = startBusy(busy.kind, t, 0.2)
  }
  const u = (t - busy.start) / busy.duration
  const w = envelope(u)
  const set = (channel: Channel, value: number) => { target[channel] = MathUtils.lerp(target[channel], value, w) }
  const add = (channel: Channel, value: number) => { target[channel] += value * w }
  const above = (x: number, y: number, z: number) => places.head().add(new Vector3(x, y, z))
  let at: Vector3
  switch (busy.kind) {
    case 'read': {
      // Reading down the screen: its eyes run along a line, then back for the next.
      const line = Math.floor(t / 1.6)
      set('bodyRX', 0.07)
      at = screen().add(new Vector3(-0.08 + 0.16 * smooth(0, 0.85, (t / 1.6) % 1), 0.04 - 0.025 * (line % 4), 0))
      break
    }
    case 'checkJob':
      set('armRRX', -1.45)
      set('armRRZ', -0.42)
      at = places.job()
      break
    case 'scratch': {
      // It scratches the side of its head in little bursts, its head tipped.
      const scratch = Math.max(0, Math.sin(t * 3.1)) * Math.sin(t * 17)
      set('armRRX', -0.45)
      set('armRRZ', -2.45)
      add('armRRZ', 0.12 * scratch)
      set('hands', -0.6)
      add('hands', 0.3 * scratch)
      set('neckRZ', 0.07)
      at = above(-0.35, 0.3, 0.6)
      break
    }
    case 'ponder':
      // A hand to its cheek, eyes up and away, a mitten tapping now and then.
      set('armRRX', -2)
      set('armRRZ', -0.75)
      set('hands', 0.5)
      add('hands', 0.2 * Math.max(0, Math.sin(t * 4.5)) ** 4)
      set('bodyRX', -0.03)
      at = above(-0.5 + 0.12 * Math.sin(t * 0.7), 0.5 + 0.06 * Math.sin(t * 1.1), 0.5)
      break
    case 'lookUp':
      // Hands off the keys, it sits back and looks up, toward its thought.
      set('armLRX', -1.2)
      set('armRRX', -1.2)
      set('bodyRX', -0.05)
      at = above(0.3 * Math.sin(t * 0.5), 0.9, 0.3)
      break
    case 'click':
      // A hand on the trackpad: the pointer moves, it clicks, its eyes follow.
      set('armRRX', -1.5)
      set('armRRZ', 0.16 + 0.07 * Math.sin(t * 1.7))
      add('click', Math.max(0, Math.sin(t * 5.3)) ** 10)
      set('bodyRX', 0.03)
      at = screen().add(new Vector3(0.06 * Math.sin(t * 1.7), 0.03 * Math.sin(t * 2.3), 0))
      break
    case 'peer':
      // It leans in close to see what came up.
      set('bodyRX', 0.12)
      set('neckRX', 0.06)
      at = screen()
      break
    case 'type':
      typeAway(target, t, w)
      at = screen()
      break
    case 'nod':
      // A pause to nod at what it wrote.
      add('neckRX', 0.12 * Math.max(0, Math.sin(u * Math.PI * 4)))
      at = screen()
      break
  }
  return w > 0.3 ? at : look
}

/**
 * BUILD BY HAND, live: the agent as a figure at a workbench, doing the work (AgentFigure renders
 * it). The model is Blender's (public/agent/workbench.glb; its script is kept locally, not in git):
 * the bench, and the figure with every head it can wear. This dresses it from the agent's settings
 * and the figure it wears, lets each object on the bench be picked up or clicked, and moves the
 * figure. It moves for two reasons only: a change you just made (it looks at what changed) and the
 * run in its chat. While the run works, it acts out what the run's events say its agent is at
 * (BenchView.phase): it reads its message, thinks (scratching its head, chin on a hand, a thought
 * bubble over its head saying what about), uses the laptop while a tool runs (its screen flashing), and types its
 * reply; when it uses something on the bench (a skill, a folder, a tool), it goes and gets it and
 * carries it back to the desk. It points at your dish when it waits on you for a key, and hands its reply to the tray
 * when it is done. Between runs it looks around and blinks. Reduced motion keeps every pose and
 * drops the motion: while it works it keeps its hands on the keys and its eyes on the screen.
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
  /** What is filed in each slot of the drawer, by what it is and where. */
  private readonly files: { group: Group | null; source: string | null }[] = Array.from({ length: READ_SLOTS }, () => ({ group: null, source: null }))
  /** Whether each drawer is open, or `null` before the first view: it opens only with something in it. */
  private readonly drawerOpen: Record<DrawerName, boolean | null> = { reads: null, tools: null }
  /** Which tool stands in each slot of the tool drawer. */
  private readonly stocked: { group: Group | null; tool: BenchTool | null }[] = Array.from({ length: TOOL_SLOTS }, () => ({ group: null, tool: null }))
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
  /** What it is at while it works, and while it uses a tool its screen's flashes as pages and results come up. */
  private readonly acting: Acting = { busy: null, flash: 0, nextFlash: 0 }
  /** The parts of its figure its pose moves, once the model is in. */
  private rig: Rig | null = null
  /** The helpers at the bench, by id (ADR 0079), and the figure they were copied from. */
  private readonly seats = new Map<string, Seat>()
  private seatedAs = ''
  /** Where its thought bubble starts: a point riding on its head, just above the top of it. */
  private readonly thoughtMark = new Object3D()
  /** Things it used, waiting to be fetched; the uses it has seen; the trip it is on; and where it stands at the desk. */
  private errands: BenchUse[] = []
  private readonly seenUses = new Set<string>()
  private trip: Trip | null = null
  private readonly figureHome = new Vector3()
  private wound: Texture | null = null
  /** Each head it can wear, and every eye (they blink together; only the worn head's show). */
  private readonly heads = new Map<FigureKind, Object3D>()
  private readonly eyes: Object3D[] = []
  private drawn = { figure: '' }
  /** What it wears from the wardrobe (docs/QUESTS.md), fitted to the head it wears now. */
  private dressed: Dressed | null = null

  private readonly options: BenchOptions

  constructor(canvas: HTMLCanvasElement, callbacks: BenchCallbacks, reduced: boolean, options: BenchOptions = {}) {
    this.callbacks = callbacks
    this.reduced = reduced
    this.options = options
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

  /** Build the bench from workbench.glb: its URL, or its bytes when they are fetched already (readModel). */
  async load(source: string | ArrayBuffer): Promise<void> {
    const gltf = await readModel(source)
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
    if (this.options.clipboardOnBoard) this.hangClipboard()
    this.buildDrawer('reads')
    this.buildDrawer('tools')
    model.updateMatrixWorld(true)
    for (const { key, node } of FIGURE_KEYS) {
      const found = this.node(`key_${node}`)
      this.keyHome.set(key, { p: found.position.clone(), q: found.quaternion.clone() })
      const middle = found.worldToLocal(new Box3().setFromObject(found).getCenter(new Vector3()))
      this.keyDish.set(key, middle.multiplyScalar(-DISH_KEY_SCALE))
    }
    this.lights()
    this.figureHome.copy(this.node('figure').position)
    this.rig = rigOf(this.node('figure'))
    this.node('head').add(this.thoughtMark)
    this.placeThought()
    // Every shader it draws with, the hidden parts' too, compiled before its first frame (readyToDraw).
    await readyToDraw(this.renderer, this.scene, this.camera)
    this.loaded = true
    this.frame()
    if (this.view) this.apply(null, this.view)
  }

  /**
   * The job's clipboard on the pegboard (BenchOptions.clipboardOnBoard): upright, its sheet facing
   * you, hung under the key hooks; the stand it leant on at the bench is put away. Its sheet's words,
   * its tag and the figure's glances at its job follow it there.
   */
  private hangClipboard() {
    const job = this.node('job')
    this.node('pegboard').add(job)
    job.position.set(CLIPBOARD_ON_BOARD.x, CLIPBOARD_ON_BOARD.y, CLIPBOARD_ON_BOARD.z)
    // The board lies along its own -z, its sheet on its +y: turned a quarter about x, the sheet
    // faces the room and the clip is at the top.
    job.rotation.set(Math.PI / 2, 0, 0)
    job.scale.setScalar(CLIPBOARD_ON_BOARD.size)
    this.node('job_stand').visible = false
  }

  /** Put the point its thought bubble starts from just above the head it wears now, and what it wears on it. */
  private placeThought() {
    const head = this.node('head')
    head.updateWorldMatrix(true, true)
    const box = new Box3()
    head.traverse((object) => { if (object instanceof Mesh && shown(object)) box.expandByObject(object) })
    if (box.isEmpty()) return
    const top = head.worldToLocal(new Vector3(0, box.max.y, 0).setX((box.min.x + box.max.x) / 2).setZ((box.min.z + box.max.z) / 2))
    this.thoughtMark.position.set(0, top.y + THOUGHT_GAP, 0)
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
    this.dressed?.undress()
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
    const figureKey = `${view.figure.kind}/${view.figure.color}/${wornBy(view.figure).join()}`
    if (this.drawn.figure !== figureKey) {
      this.drawn.figure = figureKey
      this.wear(view.figure)
    }
    for (const { node, word, key } of FIGURE_KEYS) {
      if (!this.faces.has(`key_${node}_label`)) this.paint(`key_${node}_label`, keyLabelTexture(word, key === 'commands'))
    }
    this.node('envelope').visible = view.hasReply || view.mood === 'done'
    this.pinCards(look.skills, before !== null)
    this.node('reads').visible = Boolean(view.reads)
    this.slideDrawer('reads', Boolean(view.reads?.length), before !== null)
    this.fileSources(view.reads ?? [], before !== null)
    this.node('tools').visible = Boolean(view.tools)
    this.slideDrawer('tools', Boolean(view.tools?.length), before !== null)
    this.hangTools(view.tools ?? [], before !== null)

    for (const { key } of FIGURE_KEYS) {
      const node = this.node(`key_${KEY_NODE[key]}`)
      const home = this.node(look.allow[key] ? `hook_${KEY_NODE[key]}` : `dish_${KEY_NODE[key]}`)
      if (node.parent !== home && this.drag?.key !== key && !this.tweens.some((tween) => tween.node === node)) this.homeKey(key, Boolean(look.allow[key]), before !== null)
    }

    // Each recorded event flickers its screen, as if a line had just come up.
    if (view.events > this.events && !this.reduced) this.flicker = 1
    // Each thing it uses from the bench, it goes and gets: two at most wait their turn.
    for (const use of view.uses ?? []) {
      if (this.seenUses.has(use.id)) continue
      this.seenUses.add(use.id)
      if (!this.reduced && this.errands.length < 2) this.errands.push(use)
    }
    this.events = view.events
    if (before) {
      for (const reaction of reactionsBetween(before.look, look)) this.react(reaction)
      if (before.figure.kind !== view.figure.kind || before.figure.color !== view.figure.color) this.react({ kind: 'redressed' })
      if (before.reads && view.reads && sourceKeys(before.reads) !== sourceKeys(view.reads)) this.react({ kind: 'filed' })
      if (before.tools && view.tools && toolNames(before.tools) !== toolNames(view.tools)) this.react({ kind: 'tooled' })
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
    this.dress(figure)
    this.placeThought()
  }

  /** Put on what it wears from the wardrobe, fitted to the head it wears (accessoryMeshes.ts). */
  private dress(figure: FigureChoice) {
    this.dressed?.undress()
    this.dressed = null
    const wear = wornBy(figure)
    if (wear.length > 0) this.dressed = dress(this.node('figure'), figure.kind, wear)
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

  /**
   * A drawer, made here rather than in Blender, like the recipe cards: a card-catalog front (a
   * brass frame with a card, and a brass pull), the dark mouth it slides out of, and a slot node
   * for each thing in it (`reads_1`, `tools_1`…).
   */
  private buildDrawer(name: DrawerName) {
    const holder = new Group()
    holder.name = name
    holder.position.set(DRAWER_X[name], DRAWER.bottom, DRAWER.front)
    const drawer = new Group()
    drawer.name = `${name}_drawer`
    holder.add(drawer)
    const add = (parent: Group, mesh: Mesh, part: string, x: number, y: number, z: number) => {
      mesh.name = `${name}_${part}`
      mesh.position.set(x, y, z)
      mesh.castShadow = true
      mesh.receiveShadow = true
      parent.add(mesh)
      this.pickables.push(mesh)
      this.roles.set(mesh, 'drawer')
      this.disposables.push(mesh.geometry)
      return mesh
    }
    const box = (width: number, height: number, depth: number, material: Material) => new Mesh(new BoxGeometry(width, height, depth), material)
    const { width, height, depth } = DRAWER
    // The mouth it slides out of, dark, so an open drawer reads as coming out of the bench.
    const mouth = add(holder, new Mesh(new PlaneGeometry(width + 0.02, height + 0.02), new MeshStandardMaterial({ color: '#0C0C10', roughness: 1 })), 'mouth', 0, height / 2, 0.001)
    mouth.castShadow = false
    // Its front, a shade lighter than the bench so it shows, with a card in a brass frame and a pull.
    const front = add(drawer, box(width, height, 0.024, new MeshPhysicalMaterial({ color: '#3A3A44', roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.35 })), 'front', 0, height / 2, 0.012)
    add(drawer, box(0.13, 0.054, 0.006, this.material('gold', name)), 'frame', 0, height * 0.68, 0.026)
    add(drawer, box(0.11, 0.036, 0.004, this.material('paper', name)), 'card', 0, height * 0.68, 0.029)
    add(drawer, box(0.12, 0.016, 0.014, this.material('gold', name)), 'pull', 0, height * 0.3, 0.044)
    for (const x of [-0.05, 0.05]) add(drawer, box(0.012, 0.012, 0.022, this.material('gold', name)), `post_${x < 0 ? 'l' : 'r'}`, x, height * 0.3, 0.034)
    // Its box: the floor, sides and back that hold what is in it, inside the bench while it is shut.
    const inside = () => this.material('graphite', name)
    add(drawer, box(width - 0.03, 0.008, depth, inside()), 'floor', 0, 0.012, -depth / 2)
    for (const sign of [-1, 1]) add(drawer, box(0.008, height * 0.7, depth, inside()), `side_${sign < 0 ? 'l' : 'r'}`, sign * (width / 2 - 0.02), height * 0.35 + 0.008, -depth / 2)
    add(drawer, box(width - 0.03, height * 0.7, 0.008, inside()), 'back', 0, height * 0.35 + 0.008, -depth)
    if (name === 'tools') add(drawer, box(width - 0.048, TOOL_FOAM - 0.016, depth - 0.008, new MeshStandardMaterial({ color: '#1E1E24', roughness: 0.95 })), 'foam', 0, (TOOL_FOAM + 0.016) / 2, -depth / 2)
    DRAWER_SLOTS[name].forEach((place, slot) => {
      const at = new Group()
      at.name = `${name}_${slot + 1}`
      at.position.copy(place)
      drawer.add(at)
      this.nodes.set(at.name, at)
    })
    this.scene.add(holder)
    holder.updateMatrixWorld(true)
    for (const node of [holder, drawer, front]) this.nodes.set(node.name, node)
  }

  /** Open a drawer when there is something in it; shut it when there is nothing. */
  private slideDrawer(name: DrawerName, open: boolean, animate: boolean) {
    if (this.drawerOpen[name] === open) return
    this.drawerOpen[name] = open
    const drawer = this.node(`${name}_drawer`)
    const to = new Vector3(0, 0, open ? DRAWER.open : 0)
    this.tweens = this.tweens.filter((tween) => tween.node !== drawer)
    if (!animate || this.reduced) { drawer.position.copy(to); return }
    this.tween(drawer, to, drawer.quaternion.clone(), 0.45, 0)
  }

  /** What it reads, standing in the drawer, front first, in the order the team file lists them. */
  private fileSources(sources: readonly ReadSource[], animate: boolean) {
    for (let slot = 0; slot < READ_SLOTS; slot += 1) {
      const source = sources[slot] ?? null
      const key = source ? sourceKey(source) : null
      const file = this.files[slot]
      if (file.source === key) continue
      if (file.group) this.unpin(file.group, animate)
      file.group = source ? this.file(slot, source, animate) : null
      file.source = key
    }
  }

  /** A folder (with its tab, staggered so each one's shows), or a sheet for a file or a page. */
  private file(slot: number, source: ReadSource, animate: boolean): Group {
    const group = new Group()
    group.name = `reads_${slot + 1}_${source.kind}`
    const parts: Mesh[] = []
    const piece = (width: number, height: number, color: Color | string, x: number, y: number, z: number, roughness = 0.8) => {
      const mesh = new Mesh(new BoxGeometry(width, height, 0.004), new MeshStandardMaterial({ color: new Color(color).multiplyScalar(DRAWER_SHADE), roughness }))
      mesh.position.set(x, y, z)
      mesh.castShadow = true
      mesh.receiveShadow = true
      group.add(mesh)
      parts.push(mesh)
      return mesh
    }
    if (source.kind === 'folder') {
      const tint = FOLDER_TINTS[slot % FOLDER_TINTS.length]
      piece(0.3, 0.19, tint, 0, 0.095, -0.004)
      piece(0.085, 0.028, tint, [-0.09, -0.03, 0.03, 0.09][slot % 4], 0.2, -0.004)
      piece(0.3, 0.172, new Color(tint).multiplyScalar(1.04), 0, 0.086, 0.001)
    } else {
      piece(0.26, 0.2, '#F7F4EE', 0, 0.1, 0, 0.9)
      // A few lines of text, and a page's dark mark in its corner, so a file and a page read apart.
      for (let line = 0; line < 4; line += 1) piece(line === 3 ? 0.11 : 0.18, 0.008, '#B9B1A2', line === 3 ? -0.045 : 0, 0.15 - line * 0.03, 0.003)
      if (source.kind === 'page') piece(0.03, 0.03, '#24242B', -0.1, 0.17, 0.004, 0.5)
    }
    const lean = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -0.12)
    group.quaternion.copy(lean)
    this.node(`reads_${slot + 1}`).add(group)
    for (const mesh of parts) { this.pickables.push(mesh); this.roles.set(mesh, 'file'); this.disposables.push(mesh.geometry) }
    if (animate && !this.reduced) {
      // It drops into the open drawer from in front, the way a folder is filed.
      group.scale.setScalar(0.01)
      group.position.set(0, 0.25, 0.2)
      this.tween(group, new Vector3(0, 0, 0), lean, 0.5, 0.04)
    }
    return group
  }

  /** The tools it is given, a tile each standing in the tool drawer from the left, in the order the team file lists them. */
  private hangTools(tools: readonly BenchTool[], animate: boolean) {
    const count = Math.min(tools.length, TOOL_SLOTS)
    for (let slot = 0; slot < TOOL_SLOTS; slot += 1) {
      const tool = tools[slot] ?? null
      const hung = this.stocked[slot]
      const kept = Boolean(tool && hung.group && hung.tool?.name === tool.name)
      // The row spreads out or closes up as a tool comes or goes; a new tile is put in where it stands.
      if (tool) this.placeTool(slot, count, animate && kept)
      if (kept) {
        // The same tool, its icon found once it is connected (or lost): the same tile, painted again.
        if (hung.tool!.icon !== tool!.icon) this.paintTool(hung.group!, tool!)
      } else {
        if (hung.group) this.unpin(hung.group, animate)
        hung.group = tool ? this.toolTile(slot, tool, animate) : null
      }
      hung.tool = tool
    }
  }

  private placeTool(slot: number, count: number, animate: boolean) {
    const node = this.node(`tools_${slot + 1}`)
    const { at, scale } = toolPlace(slot, count)
    if (node.position.equals(at) && node.scale.x === scale) return
    this.tweens = this.tweens.filter((tween) => tween.node !== node)
    if (!animate || this.reduced) { node.position.copy(at); node.scale.setScalar(scale); return }
    this.tween(node, at, node.quaternion.clone(), 0.4, 0, undefined, false, scale)
  }

  /**
   * A tool's tile: white enamel with rounded corners, like an app's icon, and the tool's own icon on
   * its face (ToolIcon's, in the app). It stands in the foam leaning back a little, so its face shows
   * over the drawer's front.
   */
  private toolTile(slot: number, tool: BenchTool, animate: boolean): Group {
    const group = new Group()
    group.name = `tools_${slot + 1}_tile`
    const shape = roundedSquare(TOOL_TILE, TOOL_TILE * 0.24)
    const depth = 0.008
    const bevel = 0.002
    const body = new Mesh(new ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 10 }), new MeshPhysicalMaterial({ color: new Color('#F7F5F0').multiplyScalar(DRAWER_SHADE), roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.2 }))
    body.name = `tools_${slot + 1}_body`
    body.position.z = -depth / 2
    const faceGeometry = new ShapeGeometry(shape, 10)
    // Its UVs from its corners, so the icon covers the face once.
    const uv = faceGeometry.getAttribute('uv')
    for (let index = 0; index < uv.count; index += 1) uv.setXY(index, uv.getX(index) / TOOL_TILE + 0.5, uv.getY(index) / TOOL_TILE)
    // The icon in the same shade as its tile.
    const face = new Mesh(faceGeometry, new MeshPhysicalMaterial({ map: toolTexture(tool.name, tool.icon), color: new Color().setScalar(DRAWER_SHADE), roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.2 }))
    face.name = `tools_${slot + 1}_face`
    face.position.z = depth / 2 + bevel + 0.0004
    group.add(body, face)
    group.rotation.set(-0.22, 0, MathUtils.degToRad(((slot * 29) % 5) - 2))
    this.node(`tools_${slot + 1}`).add(group)
    for (const mesh of [body, face]) {
      mesh.castShadow = true
      mesh.receiveShadow = true
      this.pickables.push(mesh)
      this.roles.set(mesh, 'tool')
      this.disposables.push(mesh.geometry)
    }
    if (animate && !this.reduced) {
      // It goes into the open drawer from in front, the way a tool is put away.
      group.scale.setScalar(0.01)
      group.position.set(0, 0.25, 0.2)
      this.tween(group, new Vector3(0, 0, 0), group.quaternion.clone(), 0.5, 0.06)
    }
    return group
  }

  private paintTool(group: Group, tool: BenchTool) {
    const face = group.children.find((child) => child.name.endsWith('_face')) as Mesh
    const material = face.material as MeshStandardMaterial
    material.map?.dispose()
    material.map = toolTexture(tool.name, tool.icon)
    material.needsUpdate = true
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

  private react(reaction: FigureReaction | { kind: 'redressed' } | { kind: 'filed' } | { kind: 'tooled' }) {
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
      case 'filed': at('file', 1.4); break
      case 'tooled': at('tool', 1.4); break
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
    // Nothing shows until it has loaded, and a frame drawn while its shaders compile would wait for them.
    if (!this.loaded) return
    this.renderer.render(this.scene, this.camera)
    this.callbacks.onFrame(this.anchors(), this.facesOnScreen())
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
      case 'working':
      case 'quiet':
        // Hands on the keys, eyes on the screen. What it is at (its phase) is acted out below;
        // without one, it types while events arrive.
        if (!view.phase && view.mood === 'working') typeAway(target, t, motion)
        target.band = 1
        target.screen = view.mood === 'working' ? 0.75 : 0.5
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

    // While it works: what it is at, acted out a few seconds at a time.
    const phase = view.mood === 'working' || view.mood === 'quiet' ? view.phase ?? null : null
    if (phase) look = this.work(phase, target, look ?? screenPoint(), screenPoint)
    else this.acting.busy = null
    // Waiting on its helpers, it watches them work, one and then another (ADR 0079).
    const watching = !phase && (view.mood === 'working' || view.mood === 'quiet') ? [...this.seats.values()].filter((seat) => seat.going === null && seat.finished === null) : []
    if (watching.length > 0 && !this.reduced) look = watching[Math.floor(t / 3.2) % watching.length].rig.head.getWorldPosition(new Vector3())
    // A trip to fetch what it just used takes it from the desk for a few seconds.
    const away = this.travel(target, dt, view.mood === 'working' || view.mood === 'quiet')
    if (away) look = away

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
        case 'file':
          // Something to read was filed in the drawer, or taken out: it looks over.
          towards(this.node('reads_drawer').getWorldPosition(new Vector3()).add(new Vector3(0, 0.15, 0.1)))
          target.bodyY += 0.025 * bump(u * 2)
          this.flashes.set('reads', 0.5 * (1 - u))
          break
        case 'tool':
          // A tool was put in its drawer, or taken out: it looks over.
          towards(this.node('tools_drawer').getWorldPosition(new Vector3()).add(new Vector3(0, 0.15, 0.1)))
          target.bodyY += 0.025 * bump(u * 2)
          this.flashes.set('tools', 0.5 * (1 - u))
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
    const rig = this.rig
    if (!rig) return
    lookToward(rig, target, look, this.camera.position, this.node('figure').rotation.y)

    // Ease every channel toward its target.
    const ease = this.reduced ? 1 : 1 - Math.exp(-dt * 8)
    for (const channel of Object.keys(target) as Channel[]) this.pose[channel] += (target[channel] - this.pose[channel]) * ease

    const p = this.pose
    posed(rig, p, t, motion)
    if (!this.reduced) this.nextBlink = blinked(this.eyes, this.now, this.nextBlink)

    const light = this.node('laptop_light') as Mesh
    const band = light.material as MeshStandardMaterial
    band.emissive.copy(LIVE)
    band.emissiveIntensity = p.band * (this.reduced ? 1 : 0.75 + 0.25 * Math.sin(t * 5)) + this.acting.flash * 0.8
    this.flicker = Math.max(0, this.flicker - dt * 4)
    this.acting.flash = Math.max(0, this.acting.flash - dt * 5)
    const screen = (this.node('laptop_screen') as Mesh).material as MeshStandardMaterial
    screen.emissiveIntensity = p.screen + this.flicker * 0.9 + this.acting.flash * 1.2
    if (this.screenLight) this.screenLight.intensity = (p.screen + this.flicker * 0.6) * 0.35 + this.acting.flash * 0.9
    this.highlight(view)

    this.liftAsked(view)
    this.seatHelpers(view, dt)

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

  /** What it does while it works, in `phase` (actOut), with its own screen, job sheet and head. */
  private work(phase: WorkPhase, target: Pose, look: Vector3 | 'viewer', screen: () => Vector3): Vector3 | 'viewer' {
    return actOut(phase, this.acting, target, this.now, { reduced: this.reduced, away: this.trip !== null }, look, {
      screen,
      job: () => this.node('job').getWorldPosition(new Vector3()),
      head: () => this.node('head').getWorldPosition(new Vector3()),
    })
  }

  /**
   * The helpers at the bench (ADR 0079), each frame: a seat for each new one, each acting out its
   * own work with the figure's own logic (actOut, lookToward, posed), a nod as it hands its part
   * back, and its going once the view lets it go. Reduced motion seats and unseats them at once and
   * keeps their pose still, as it keeps the figure's.
   */
  private seatHelpers(view: BenchView, dt: number) {
    const t = this.now
    const motion = this.reduced ? 0 : 1
    const wanted = new Map((view.helpers ?? []).map((helper) => [helper.id, helper]))
    // A copy of a figure that changed what it wears goes, and comes back as the new one.
    const figure = this.drawn.figure
    if (figure !== this.seatedAs) {
      this.seatedAs = figure
      for (const seat of this.seats.values()) seat.going ??= t
    }
    for (const helper of wanted.values()) {
      if (this.seats.get(helper.id)?.going === null) continue
      if (this.seats.has(helper.id)) continue
      const taken = new Set([...this.seats.values()].map((seat) => seat.slot))
      const slot = HELPER_SEATS.findIndex((_, index) => !taken.has(index))
      if (slot < 0) continue
      this.seats.set(helper.id, this.seat(helper.id, slot))
    }
    const ease = this.reduced ? 1 : 1 - Math.exp(-dt * 8)
    for (const seat of [...this.seats.values()]) {
      const helper = wanted.get(seat.id)
      if (!helper && seat.going === null) seat.going = t
      if (helper && helper.state !== 'working' && seat.finished === null) seat.finished = t
      const size = seat.going !== null
        ? HELPER_SIZE * (this.reduced ? 0 : 1 - smooth(0, HELPER_OUT, t - seat.going))
        : HELPER_SIZE * (this.reduced ? 1 : 1 - (1 - smooth(0, HELPER_IN, t - seat.born)) ** 2 + 0.12 * bump((t - seat.born) / HELPER_IN) * (t - seat.born < HELPER_IN ? 1 : 0))
      if (size <= 0.001 && seat.going !== null) {
        this.unseat(seat)
        continue
      }
      seat.group.scale.setScalar(size)

      const target: Pose = { ...REST }
      const screenPoint = () => seat.lid.getWorldPosition(new Vector3()).add(new Vector3(0, 0.12 * HELPER_SIZE, 0))
      let look: Vector3 | 'viewer' | null = screenPoint()
      if (!helper || helper.state === 'working') {
        target.band = 1
        target.screen = 0.75
        if (helper?.phase) {
          look = actOut(helper.phase, seat.acting, target, t, { reduced: this.reduced, away: false }, screenPoint(), {
            screen: screenPoint,
            job: () => this.node('job').getWorldPosition(new Vector3()),
            head: () => seat.rig.head.getWorldPosition(new Vector3()),
          })
        } else {
          seat.acting.busy = null
          typeAway(target, t, motion)
        }
      } else if (helper.state === 'done') {
        // Its part done, it turns to the figure and nods, handing it back.
        seat.acting.busy = null
        target.screen = 0.3
        target.neckRX += 0.14 * Math.max(0, Math.sin((t - (seat.finished ?? t)) * 7)) * motion
        target.bodyY += 0.02 * bump((t - (seat.finished ?? t)) * 1.4) * motion
        look = this.rig?.head.getWorldPosition(new Vector3()) ?? 'viewer'
      } else {
        // It couldn't finish: its hands come off the keys, and it looks at its screen.
        seat.acting.busy = null
        target.armLRX = -0.55
        target.armRRX = -0.55
        target.lookY = -0.6
        target.screen = 0.2
      }
      lookToward(seat.rig, target, look, this.camera.position, seat.group.rotation.y)
      for (const channel of Object.keys(target) as Channel[]) seat.pose[channel] += (target[channel] - seat.pose[channel]) * ease
      posed(seat.rig, seat.pose, t, motion)
      if (!this.reduced) seat.nextBlink = blinked(seat.eyes, t, seat.nextBlink)
      seat.band.emissive.copy(LIVE)
      seat.band.emissiveIntensity = seat.pose.band * (this.reduced ? 1 : 0.75 + 0.25 * Math.sin(t * 5 + seat.slot)) + seat.acting.flash * 0.8
      seat.screen.emissiveIntensity = seat.pose.screen + seat.acting.flash * 1.2
      seat.acting.flash = Math.max(0, seat.acting.flash - dt * 5)
    }
  }

  /**
   * A seat for helper `id` at `slot`: a copy of the figure as it is now, behind a copy of its laptop,
   * turned a little toward the middle of the bench. Its screen and light are its own, so they glow
   * with its work and not the figure's; everything else it shares with the figure it copies.
   */
  private seat(id: string, slot: number): Seat {
    const place = HELPER_SEATS[slot]
    const laptopNode = this.node('laptop')
    const laptop = laptopNode.clone(true)
    laptop.position.set(0, 0, 0)
    const figure = this.node('figure').clone(true)
    figure.position.copy(this.figureHome).sub(laptopNode.position)
    figure.rotation.set(0, 0, 0)
    const group = new Group()
    group.name = `helper_${slot}`
    group.add(laptop, figure)
    group.position.set(place.x, laptopNode.position.y, place.z)
    group.rotation.y = place.x > 0 ? -0.28 : 0.28
    group.scale.setScalar(this.reduced ? HELPER_SIZE : 0)
    const own = (name: string): MeshStandardMaterial => {
      const mesh = laptop.getObjectByName(name) as Mesh
      const material = (mesh.material as MeshStandardMaterial).clone()
      mesh.material = material
      return material
    }
    const screen = own('laptop_screen')
    const band = own('laptop_light')
    const eyes: Object3D[] = []
    figure.traverse((object) => { if (/_eye_[lr]$/.test(object.name)) eyes.push(object) })
    this.scene.add(group)
    group.updateMatrixWorld(true)
    return {
      id, slot, group, rig: rigOf(figure), lid: laptop.getObjectByName('laptop_lid') ?? laptop, eyes, screen, band,
      acting: { busy: null, flash: 0, nextFlash: 0 }, pose: { ...this.pose }, nextBlink: this.now + 1 + slot * 0.7,
      born: this.now, going: null, finished: null,
    }
  }

  /** A helper's seat taken away: its copies leave the scene, and its own screen and light go with them. */
  private unseat(seat: Seat) {
    this.scene.remove(seat.group)
    seat.screen.dispose()
    seat.band.dispose()
    this.seats.delete(seat.id)
  }

  /**
   * A trip to fetch what it just used (BenchUse), one at a time: it goes to the thing (back to the
   * pegboard for a recipe card, round the end of the bench to a drawer), hops or bends to take it,
   * carries it back to the desk and looks at it, and the thing goes back to its place. It returns
   * where it looks while it is away, or null at the desk. It starts trips only while the run is
   * live, and none under reduced motion.
   */
  private travel(target: Pose, dt: number, live: boolean): Vector3 | null {
    if (!live && this.errands.length > 0) this.errands = []
    if (!this.trip) {
      const use = this.errands.shift()
      this.trip = use ? this.tripTo(use) : null
      if (!this.trip) return null
    }
    const trip = this.trip
    const figure = this.node('figure')
    const [out, reach, back, desk] = trip.legs
    const t = this.now - trip.start
    const thing = () => trip.item.getWorldPosition(new Vector3())
    const set = (channel: Channel, value: number, weight = 1) => { target[channel] = MathUtils.lerp(target[channel], value, weight) }
    // Carrying it in both hands in front of it.
    const carry = (weight: number) => { set('armRRX', -1.15, weight); set('armLRX', -1.15, weight); set('armRRZ', 0.28, weight); set('armLRZ', -0.28, weight) }
    target.typing = 0
    let place = this.figureHome.clone()
    let yaw = 0
    let stride = -1
    let look: Vector3
    if (t < out + reach + back) {
      if (t >= out && t < out + reach) {
        // There: it turns to the thing, hops or bends, and takes it.
        const u = (t - out) / reach
        place = trip.path[trip.path.length - 1].clone()
        place.y += trip.hop * bump(u)
        yaw = trip.face
        const w = smooth(0, 0.35, u) * (1 - smooth(0.55, 0.9, u))
        if (trip.reach === 'up') { set('armRRX', -2.75, w); set('armRRZ', 0.1, w) }
        else { set('armRRX', -0.85, w); set('armLRX', -0.85, w); set('bodyRX', 0.3, w) }
        if (!trip.picked && u >= 0.5) this.take(trip)
        if (trip.picked) carry(smooth(0.55, 0.9, u))
        look = thing()
      } else {
        // On its way: there along the path, or back along it with the thing.
        const going = t < out
        const u = going ? t / out : (t - out - reach) / back
        const walked = smooth(0, 1, u) * trip.length
        const { point, heading } = alongPath(trip.path, going ? walked : trip.length - walked)
        place = point
        yaw = going ? heading : heading + Math.PI
        stride = walked
        if (trip.picked) carry(1)
        else {
          set('armLRX', -0.5 + 0.35 * Math.sin(walked * 16))
          set('armRRX', -0.5 - 0.35 * Math.sin(walked * 16))
        }
        look = going ? thing() : point.clone().add(new Vector3(0, 0.9, 0)).addScaledVector(new Vector3(Math.sin(yaw), 0, Math.cos(yaw)), 0.8)
      }
    } else if (t < out + reach + back + desk) {
      // Back at the desk, it holds it up and looks at it, then puts it back.
      const u = (t - out - reach - back) / desk
      if (!trip.returned && u >= 0.6) this.putBack(trip)
      const w = 1 - smooth(0.55, 0.85, u)
      set('armRRX', -1.75, w)
      set('armRRZ', 0.3, w)
      set('armLRX', -1.3, w)
      look = trip.returned ? this.node('laptop_lid').getWorldPosition(new Vector3()).add(new Vector3(0, 0.12, 0)) : thing()
    } else {
      if (!trip.returned) this.putBack(trip)
      figure.position.copy(this.figureHome)
      figure.rotation.set(0, 0, 0)
      this.trip = null
      return null
    }
    // A little hop at each step while it goes.
    figure.position.copy(place)
    figure.position.y += stride >= 0 ? 0.03 * Math.abs(Math.sin(stride * 8)) : 0
    figure.rotation.z = stride >= 0 ? 0.07 * Math.sin(stride * 8) : 0
    const turn = Math.atan2(Math.sin(yaw - figure.rotation.y), Math.cos(yaw - figure.rotation.y))
    const turned = figure.rotation.y + turn * (1 - Math.exp(-dt * 9))
    figure.rotation.y = Math.atan2(Math.sin(turned), Math.cos(turned))
    return look
  }

  /** The way to what it used, and how it reaches it, or null when it isn't on the bench (more than the bench shows). */
  private tripTo(use: BenchUse): Trip | null {
    const home = this.figureHome
    let item: Object3D | null | undefined
    let still: () => boolean
    let path: Vector3[]
    let hop = 0
    let reach: Trip['reach'] = 'down'
    let held: number
    if (use.kind === 'skill') {
      const slot = this.cards.findIndex((card) => card.skill === use.name)
      const card = this.cards[slot]?.group
      if (!card) return null
      item = card
      still = () => this.cards[slot].group === card
      const at = card.getWorldPosition(new Vector3())
      // Back to the pegboard behind it, under the card, and up to it.
      path = [home.clone(), new Vector3(at.x, home.y, -0.84)]
      hop = MathUtils.clamp(at.y - 0.42 - home.y, 0, 0.4)
      reach = 'up'
      held = 0.7
    } else {
      const side: DrawerName = use.kind === 'read' ? 'reads' : 'tools'
      const slot = use.kind === 'read' ? this.files.findIndex((file) => file.source?.split('\n')[1] === use.name) : this.stocked.findIndex((hung) => hung.tool?.name === use.name)
      const group = use.kind === 'read' ? this.files[slot]?.group : this.stocked[slot]?.group
      if (!group) return null
      item = group
      still = () => (use.kind === 'read' ? this.files[slot].group : this.stocked[slot].group) === group
      const at = group.getWorldPosition(new Vector3())
      // Round the end of the bench, down to the floor, and in front of the drawer.
      const end = Math.sign(DRAWER_X[side]) * BENCH_END
      const front = at.z + 0.3
      path = [home.clone(), new Vector3(end, home.y, home.z), new Vector3(end, FLOOR_Y, front), new Vector3(at.x, FLOOR_Y, front)]
      held = use.kind === 'read' ? 0.55 : 0.9
    }
    if (!item.parent) return null
    const at = item.getWorldPosition(new Vector3())
    const spot = path[path.length - 1]
    const face = Math.atan2(at.x - spot.x, at.z - spot.z)
    let length = 0
    for (let index = 1; index < path.length; index += 1) length += path[index].distanceTo(path[index - 1])
    const walk = Math.max(0.8, length / STRIDE)
    return { item, home: { parent: item.parent, p: item.position.clone(), q: item.quaternion.clone(), s: item.scale.x }, still, path, length, face, hop, reach, held, start: this.now, legs: [walk, REACH_S, walk, LOOK_S], picked: false, returned: false }
  }

  /** It takes the thing in its right hand. */
  private take(trip: Trip) {
    trip.picked = true
    if (!trip.still()) return
    this.tweens = this.tweens.filter((tween) => tween.node !== trip.item)
    this.node('hand_r').attach(trip.item)
    this.tween(trip.item, new Vector3(0, -0.07, 0.06), new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2), 0.35, 0, undefined, false, trip.held)
  }

  /** The thing goes back where it lives, unless it was taken off the bench meanwhile. */
  private putBack(trip: Trip) {
    trip.returned = true
    if (!trip.picked || !trip.still()) return
    this.tweens = this.tweens.filter((tween) => tween.node !== trip.item)
    trip.home.parent.attach(trip.item)
    this.tween(trip.item, trip.home.p, trip.home.q, 0.6, 0.12, undefined, false, trip.home.s)
  }

  /** Now and then it blinks: both eyes close for a moment. Not under reduced motion. */
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
      thought: this.screen(this.thoughtMark.getWorldPosition(new Vector3())),
      app: this.screen(world('laptop_face', [0, 0, 0])),
      name: this.screen(world('nameplate', [0, 0, 0])),
      job: this.screen(world('job', [0, 0.3, -0.12])),
      skills: this.screen(cards),
      // Under each drawer's front, on the bench's face, so they follow the drawers as they slide.
      reads: this.screen(world('reads_front', [0, -DRAWER.height / 2 - 0.012, 0.012])),
      tools: this.screen(world('tools_front', [0, -DRAWER.height / 2 - 0.012, 0.012])),
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
    const name = { mind: null, app: 'laptop_lid', name: 'nameplate', job: 'job', skills: 'card_3', reads: 'reads_drawer', tools: 'tools_drawer', keys: 'hooks', reply: 'tray' }[part]
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

/** What a source is, and where, so a slot keeps its folder until a different one goes there. */
const sourceKey = (source: ReadSource) => `${source.kind}\n${source.name}\n${source.where}`
const sourceKeys = (sources: readonly ReadSource[]) => sources.map(sourceKey).join('\n\n')
const toolNames = (tools: readonly BenchTool[]) => tools.map((tool) => tool.name).join('\n')
