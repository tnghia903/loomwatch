import { Color, Mesh, MeshStandardMaterial, Object3D, PlaneGeometry, Texture, type MeshPhysicalMaterial } from 'three'
import { expect, it } from 'vitest'

import { pileColor, SHEEN_TOWARD_WHITE } from '../components/agents/workbenchModel'
import { COLOR_HEX, FIGURE_KINDS } from '../lib/library/figures'
import { dressFigure } from './crewScene'

/** A figure as the model names it: a skin, a deep skin and every head, with only role-named materials. */
function figure() {
  const root = new Object3D()
  const part = (role: string) => {
    const material = new MeshStandardMaterial()
    material.name = role
    const mesh = new Mesh(new PlaneGeometry(), material)
    mesh.name = role
    root.add(mesh)
  }
  part('skin')
  part('skin_deep')
  for (const kind of FIGURE_KINDS) {
    const head = new Object3D()
    head.name = `head_${kind}`
    root.add(head)
  }
  return root
}

it('dresses a crew figure in its colour, its velvet sheen a pale tint of that colour, not white', () => {
  const meshes = dressFigure(figure(), { figure: { kind: 'pincushion', color: 'lilac' } }, new Texture(), (item) => item)
  const skin = meshes.find((mesh) => mesh.userData.role === 'skin')!.material as MeshPhysicalMaterial
  const lilac = pileColor(COLOR_HEX.lilac)
  expect(skin.color.getHexString()).toBe(lilac.getHexString())
  expect(skin.sheenColor.getHexString()).toBe(lilac.clone().lerp(new Color('#FFFFFF'), SHEEN_TOWARD_WHITE).getHexString())

  const deep = meshes.find((mesh) => mesh.userData.role === 'skin_deep')!.material as MeshPhysicalMaterial
  expect(deep.sheenColor.getHexString()).not.toBe('ffffff')
})
