import { Color, Mesh, MeshStandardMaterial, Object3D, PlaneGeometry, Texture, type MeshPhysicalMaterial } from 'three'
import { expect, it } from 'vitest'

import { SHEEN_TOWARD_WHITE } from '../components/agents/workbenchModel'
import { LIVE_HEX } from '../lib/library/figureHex'
import { CREW_PILE, dressFigure } from './crewScene'

/** A build's figure as its glb names it: a skin, every job's sign and a worn piece, with only role-named materials. */
function figure() {
  const root = new Object3D()
  const part = (name: string, role: string) => {
    const material = new MeshStandardMaterial()
    material.name = role
    const mesh = new Mesh(new PlaneGeometry(), material)
    mesh.name = name
    root.add(mesh)
    return mesh
  }
  part('head_mesh', 'skin')
  for (const sign of ['research', 'write', 'review', 'curl']) part(`sign_${sign}`, 'skin')
  for (const piece of ['collar', 'striped_top', 'striped_top_sleeve_l', 'gloves_l', 'gloves_r', 'ballet_flats_l']) {
    part(`wear_${piece}`, `wear_${piece.replace(/(_sleeve)?(_[lr])?$/, '')}`)
  }
  return root
}

it('dresses a crew figure in its live velvet colour, as the bench paints it, its sheen a pale tint of that colour, not white', () => {
  const root = figure()
  const meshes = dressFigure(root, { figure: { kind: 'tall', color: 'lilac', sign: 'review' } }, new Texture(), (item) => item)
  const skin = meshes.find((mesh) => mesh.name === 'head_mesh')!.material as MeshPhysicalMaterial
  const lilac = new Color(LIVE_HEX.lilac)
  expect(skin.color.getHexString()).toBe(lilac.getHexString())
  expect(skin.sheenColor.getHexString()).toBe(lilac.clone().lerp(new Color('#FFFFFF'), SHEEN_TOWARD_WHITE).getHexString())
})

it('wears only its own job’s sign and only the pieces it wears, sleeves and pairs too, so its size is its own', () => {
  const root = figure()
  dressFigure(root, { figure: { kind: 'tall', color: 'sage', sign: 'review', wear: ['striped_top', 'gloves'] } }, new Texture(), (item) => item)
  const names = root.children.map((child) => child.name)
  expect(names.filter((name) => name.startsWith('sign_'))).toEqual(['sign_review'])
  expect(names.filter((name) => name.startsWith('wear_')).sort()).toEqual(['wear_gloves_l', 'wear_gloves_r', 'wear_striped_top', 'wear_striped_top_sleeve_l'])
})

it('dresses what it wears in cloth, not the bench’s fallback grey', () => {
  const root = figure()
  dressFigure(root, { figure: { kind: 'tall', color: 'sage', wear: ['striped_top'] } }, new Texture(), (item) => item)
  const top = root.getObjectByName('wear_striped_top') as Mesh
  expect((top.material as MeshPhysicalMaterial).name).toBe('wear_striped_top')
  expect((top.material as MeshPhysicalMaterial).roughness).toBeGreaterThanOrEqual(0.9)
})

it('wears the curl when it has no job’s sign, and nothing when it wears nothing', () => {
  const root = figure()
  dressFigure(root, { figure: { kind: 'egg', color: 'rose' } }, new Texture(), (item) => item)
  expect(root.children.map((child) => child.name).filter((name) => name.startsWith('sign_'))).toEqual(['sign_curl'])
  expect(root.children.some((child) => child.name.startsWith('wear_'))).toBe(false)
})

it('lays a light velvet pile on its velvet, in the velvet’s own colour', () => {
  const root = figure()
  const meshes = dressFigure(root, { figure: { kind: 'wide', color: 'clay', sign: 'write' } }, new Texture(), (item) => item)
  const head = meshes.find((mesh) => mesh.name === 'head_mesh')!
  const pile = head.children.filter((child): child is Mesh => child instanceof Mesh && (child.material as MeshPhysicalMaterial).name === 'pile')
  expect(pile).toHaveLength(CREW_PILE.shells)
  expect((pile[0].material as MeshPhysicalMaterial).color).toBe((head.material as MeshPhysicalMaterial).color)
})

it('lays no pile under its shoes or gloves, where it would poke through them', () => {
  const root = figure()
  for (const name of ['foot_l', 'hand_l_mitten']) {
    const material = new MeshStandardMaterial()
    material.name = 'skin'
    const mesh = new Mesh(new PlaneGeometry(), material)
    mesh.name = name
    root.add(mesh)
  }
  dressFigure(root, { figure: { kind: 'little', color: 'sage', wear: ['ballet_flats'] } }, new Texture(), (item) => item)
  const piled = (name: string) => root.getObjectByName(name)!.children.some((child) => child instanceof Mesh && (child.material as MeshPhysicalMaterial).name === 'pile')
  expect(piled('foot_l')).toBe(false)
  expect(piled('hand_l_mitten')).toBe(true)
})
