import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Color, DirectionalLight, MeshPhysicalMaterial, MeshStandardMaterial, Scene, Texture, WebGLRenderTarget } from 'three'
import { describe, expect, it, vi } from 'vitest'
import { COLOR_HEX } from '../../lib/library/figures'
import { benchMaterial, pileColor, renewShadows } from './workbenchModel'

const textures = { pegboard: () => new Texture(), wound: null }

// The material names in workbench.glb's JSON chunk: each is a role the bench draws its own way.
function modelRoles(): string[] {
  const bytes = readFileSync(resolve(process.cwd(), 'public/agent/workbench.glb'))
  const length = bytes.readUInt32LE(12)
  const json = JSON.parse(bytes.subarray(20, 20 + length).toString('utf8')) as { materials: { name: string }[] }
  return json.materials.map((material) => material.name)
}

describe('benchMaterial', () => {
  it('give every part of the model a look of its own, so none is drawn in the fallback grey', () => {
    const roles = modelRoles()
    expect(roles).toContain('blush')
    const fallback = (benchMaterial('no such role', '', textures) as MeshStandardMaterial).color.getHexString()
    const grey = roles.filter((role) => (benchMaterial(role, role, textures) as MeshStandardMaterial).color.getHexString() === fallback)
    expect(grey).toEqual([])
  })

  it('draw the figure soft to the touch, as its stills are: matte, with no clear coat', () => {
    for (const role of ['skin', 'skin_wound', 'skin_deep']) {
      const material = benchMaterial(role, role, textures) as MeshPhysicalMaterial
      expect(material.clearcoat).toBe(0)
      expect(material.roughness).toBeGreaterThanOrEqual(0.6)
    }
  })

  it('gives the figure the short flocked pile of its stills: a full velvet sheen over a rough skin', () => {
    for (const role of ['skin', 'skin_wound', 'skin_deep']) {
      const material = benchMaterial(role, role, textures) as MeshPhysicalMaterial
      expect(material.sheen).toBeGreaterThanOrEqual(0.9)
      expect(material.roughness).toBeGreaterThanOrEqual(0.85)
    }
  })

  it('lifts a figure colour back from the grey its pile gives it, keeping its hue and lightness', () => {
    const given = { h: 0, s: 0, l: 0 }
    const shown = { h: 0, s: 0, l: 0 }
    new Color(COLOR_HEX.sky).getHSL(given)
    pileColor(COLOR_HEX.sky).getHSL(shown)
    expect(shown.s).toBeCloseTo(given.s * 1.2, 3)
    expect(shown.h).toBeCloseTo(given.h, 3)
    expect(shown.l).toBeCloseTo(given.l, 3)
  })

  it('leaves butter as it is, since lifted it is the gold of the app', () => {
    expect(pileColor(COLOR_HEX.butter).getHexString()).toBe(new Color(COLOR_HEX.butter).getHexString())
  })

  it('lays its cheeks over the skin as a see-through blush', () => {
    const blush = benchMaterial('blush', 'spool_blush_l', textures) as MeshStandardMaterial
    expect(blush.transparent).toBe(true)
    expect(blush.opacity).toBeLessThan(1)
  })
})

describe('renewShadows', () => {
  it('drops the shadow map of a light, so three draws a fresh one on the next frame', () => {
    const scene = new Scene()
    const key = new DirectionalLight()
    key.castShadow = true
    scene.add(key)
    const first = new WebGLRenderTarget(4, 4)
    const disposed = vi.spyOn(first, 'dispose')
    key.shadow.map = first
    renewShadows(scene)
    expect(key.shadow.map).toBeNull()
    expect(disposed).toHaveBeenCalled()
  })
})
