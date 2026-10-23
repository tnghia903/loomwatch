import { Color, Mesh, PlaneGeometry, Texture, type MeshPhysicalMaterial } from 'three'
import { expect, it, vi } from 'vitest'

import { COLOR_HEX } from '../../lib/library/figures'
import { benchMaterial, pileColor, SHEEN_TOWARD_WHITE } from './workbenchModel'
import { WorkbenchScene } from './workbenchScene'

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

type Inside = { roles: Map<Mesh, string>; wear(figure: { kind: string; color: string }): void; dress(): void; placeThought(): void }

it('dresses the bench figure in its colour, its velvet sheen a pale tint of that colour, not white', () => {
  const scene = new WorkbenchScene(document.createElement('canvas'), { onPart() {}, onKey() {}, onHover() {}, onFrame() {} }, false)
  const inside = scene as unknown as Inside
  const textures = { pegboard: () => new Texture(), wound: null }
  const skin = new Mesh(new PlaneGeometry(), benchMaterial('skin', 'pincushion_body', textures))
  const deep = new Mesh(new PlaneGeometry(), benchMaterial('skin_deep', 'pincushion_leaf', textures))
  inside.roles.set(skin, 'skin')
  inside.roles.set(deep, 'skin_deep')
  vi.spyOn(inside, 'dress').mockImplementation(() => {})
  vi.spyOn(inside, 'placeThought').mockImplementation(() => {})

  // Sky, not clay: clay is the material's own colour, so a bench that never tinted would still pass.
  inside.wear({ kind: 'pincushion', color: 'sky' })

  const sky = pileColor(COLOR_HEX.sky)
  const material = skin.material as MeshPhysicalMaterial
  expect(material.color.getHexString()).toBe(sky.getHexString())
  expect(material.sheenColor.getHexString()).toBe(sky.clone().lerp(new Color('#FFFFFF'), SHEEN_TOWARD_WHITE).getHexString())
  expect((deep.material as MeshPhysicalMaterial).sheenColor.getHexString()).not.toBe('ffffff')
  scene.dispose()
})
