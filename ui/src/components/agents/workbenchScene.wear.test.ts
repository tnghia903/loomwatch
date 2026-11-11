import { Box3, BoxGeometry, Color, Group, Mesh, MeshStandardMaterial, Object3D, PlaneGeometry, Texture, Vector3, type MeshPhysicalMaterial } from 'three'
import { expect, it, vi } from 'vitest'

import { LIVE_HEX } from '../../lib/library/figureHex'
import { benchMaterial, SHEEN_TOWARD_WHITE } from './workbenchModel'
import { CLIPBOARD_ON_BOARD, COFFEE_ON_DESK, WorkbenchScene } from './workbenchScene'

// jsdom has no WebGL: the renderer, and the room light made with it, are stood in for. What is
// checked here is how the bench colours the figure it wears, not what it draws.
vi.mock('three', async (load) => {
  const three = await load<typeof import('three')>()
  return {
    ...three,
    WebGLRenderer: class { shadowMap = {}; setClearColor() {} render() {} dispose() {} },
    PMREMGenerator: class { fromScene() { return { texture: new three.Texture() } } dispose() {} },
  }
})

type Inside = { roles: Map<Mesh, string>; nodes: Map<string, Object3D>; build: string | null; wear(figure: { kind: string; color: string; sign?: string; wear?: string[] }): void; placeThought(): void }

/** The bench as if build `kind` were on: its figure node holding `parts`. */
function onBuild(inside: Inside, kind: string, parts: string[] = []) {
  const figure = new Group()
  figure.name = 'figure'
  for (const name of parts) { const part = new Object3D(); part.name = name; figure.add(part) }
  inside.nodes.set('figure', figure)
  inside.build = kind
  return figure
}

it('dresses the bench figure in its colour, its velvet sheen a pale tint of that colour, not white', () => {
  const scene = new WorkbenchScene(document.createElement('canvas'), { onPart() {}, onKey() {}, onHover() {}, onFrame() {} }, false)
  const inside = scene as unknown as Inside
  const textures = { pegboard: () => new Texture(), wound: null }
  const skin = new Mesh(new PlaneGeometry(), benchMaterial('skin', 'pincushion_body', textures))
  const deep = new Mesh(new PlaneGeometry(), benchMaterial('skin_deep', 'pincushion_leaf', textures))
  inside.roles.set(skin, 'skin')
  inside.roles.set(deep, 'skin_deep')
  vi.spyOn(inside, 'placeThought').mockImplementation(() => {})
  onBuild(inside, 'egg')

  // Sky, not clay: clay is the material's own colour, so a bench that never tinted would still pass.
  inside.wear({ kind: 'egg', color: 'sky' })

  const sky = new Color(LIVE_HEX.sky)
  const material = skin.material as MeshPhysicalMaterial
  expect(material.color.getHexString()).toBe(sky.getHexString())
  expect(material.sheenColor.getHexString()).toBe(sky.clone().lerp(new Color('#FFFFFF'), SHEEN_TOWARD_WHITE).getHexString())
  expect((deep.material as MeshPhysicalMaterial).sheenColor.getHexString()).not.toBe('ffffff')
  scene.dispose()
})

it('shows on the figure only its own job’s sign and what it wears, each of the build’s pieces hidden till worn', () => {
  const scene = new WorkbenchScene(document.createElement('canvas'), { onPart() {}, onKey() {}, onHover() {}, onFrame() {} }, false)
  const inside = scene as unknown as Inside
  vi.spyOn(inside, 'placeThought').mockImplementation(() => {})
  const figure = onBuild(inside, 'tall', ['sign_research', 'sign_curl', 'sign_code', 'wear_collar', 'wear_striped_top', 'wear_striped_top_sleeve_l', 'wear_cardigan', 'wear_cardigan_sleeve_r', 'wear_gloves_l'])
  const shown = () => figure.children.filter((part) => part.visible).map((part) => part.name).sort()

  inside.wear({ kind: 'tall', color: 'lilac', sign: 'research', wear: ['collar', 'striped_top'] })
  expect(shown()).toEqual(['sign_research', 'wear_collar', 'wear_striped_top', 'wear_striped_top_sleeve_l'])

  // No job's icon: the plain curl; the gloves on both paws, the garment off with its sleeves.
  inside.wear({ kind: 'tall', color: 'lilac', wear: ['gloves'] })
  expect(shown()).toEqual(['sign_curl', 'wear_gloves_l'])
  scene.dispose()
})

it('hangs the job’s sheet on the board clear of the sign on the figure’s head, and of the key hooks', () => {
  // Measured on the bench in its own space (the pegboard's): the sheet is 0.38 of its size wide
  // about its middle; every build's sign starts at -0.181 or right of it, and the last key hook is at
  // -0.552, its key hanging about 0.06 either side of it.
  const half = 0.38 * CLIPBOARD_ON_BOARD.size / 2
  expect(CLIPBOARD_ON_BOARD.x + half).toBeLessThan(-0.181)
  expect(CLIPBOARD_ON_BOARD.x - half).toBeGreaterThan(-0.552 + 0.06)
})

it('sets the coffee a figure wears down on the desk, upright, out of its paw, where the plaque hid it', () => {
  const scene = new WorkbenchScene(document.createElement('canvas'), { onPart() {}, onKey() {}, onHover() {}, onFrame() {} }, false)
  const inside = scene as unknown as Inside
  vi.spyOn(inside, 'placeThought').mockImplementation(() => {})
  const bench = new Group()
  bench.name = 'bench'
  inside.nodes.set('bench', bench)
  const figure = onBuild(inside, 'egg', ['sign_review'])
  figure.position.set(0, 0.44, -0.53)
  bench.add(figure)
  // In the paw, as the model has it: off to the side, below and in front of the paw's middle.
  const paw = new Group()
  paw.position.set(-0.12, 0.2, 0.05)
  paw.rotation.set(0.6, 0.2, -0.4)
  figure.add(paw)
  const cup = new Mesh(new BoxGeometry(0.06, 0.1, 0.06).translate(-0.04, 0.02, 0.03), new MeshStandardMaterial())
  cup.name = 'wear_coffee'
  paw.add(cup)

  inside.wear({ kind: 'egg', color: 'rose', sign: 'review', wear: ['coffee'] })
  expect(cup.parent).toBe(bench)
  expect(cup.visible).toBe(true)
  const box = new Box3().setFromObject(cup)
  const base = new Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2)
  expect(base.x).toBeCloseTo(COFFEE_ON_DESK.x, 5)
  expect(base.y).toBeCloseTo(COFFEE_ON_DESK.y, 5)
  expect(base.z).toBeCloseTo(COFFEE_ON_DESK.z, 5)
  // Upright: its height is the cup's own, not tipped as the paw was.
  expect(box.max.y - box.min.y).toBeCloseTo(0.1, 5)

  // Not worn, it is hidden on the desk.
  inside.wear({ kind: 'egg', color: 'rose', sign: 'review', wear: [] })
  expect(cup.visible).toBe(false)
  scene.dispose()
})

it('stands the coffee clear of your dish, the laptop, the helpers’ seats and the desk’s front edge', () => {
  // Measured on the bench (workbench.glb), in its own space, with room for a cup about 0.07 across.
  const r = 0.07
  expect(COFFEE_ON_DESK.x - r).toBeGreaterThan(-0.642)
  expect(COFFEE_ON_DESK.x + r).toBeLessThan(-0.15)
  expect(COFFEE_ON_DESK.z - r).toBeGreaterThan(-0.03)
  expect(COFFEE_ON_DESK.z + r).toBeLessThan(0.36)
  expect(COFFEE_ON_DESK.y).toBeCloseTo(0.62, 2)
})
