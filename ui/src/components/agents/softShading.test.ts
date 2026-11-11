import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three'
import { expect, it } from 'vitest'

import { hideUnshaded, SHADING } from './softShading'

it('shades only what it is asked to: a figure darkens round itself, the wall behind it doesn’t', () => {
  const scene = new Scene()
  const figure = new Object3D()
  figure.name = 'figure'
  const torso = new Mesh(new BoxGeometry(), new MeshStandardMaterial())
  figure.add(torso)
  const wall = new Mesh(new BoxGeometry(), new MeshStandardMaterial())
  const hiddenAlready = new Mesh(new BoxGeometry(), new MeshStandardMaterial())
  hiddenAlready.visible = false
  scene.add(figure, wall, hiddenAlready)
  const hidden = hideUnshaded(scene, (mesh) => mesh.parent === figure)
  expect(hidden).toEqual([wall])
  expect(wall.visible).toBe(false)
  expect(torso.visible).toBe(true)
  // Only what it hid is shown again: what was hidden before stays so.
  expect(hidden).not.toContain(hiddenAlready)
})

it('looks a figure’s width round a point for what crowds it, and darkens it most of the way', () => {
  expect(SHADING.radius).toBeGreaterThan(0.05)
  expect(SHADING.radius).toBeLessThan(0.3)
  expect(SHADING.strength).toBeGreaterThan(0.5)
  expect(SHADING.strength).toBeLessThanOrEqual(1)
})
