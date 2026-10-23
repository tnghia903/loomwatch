import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MeshPhysicalMaterial, MeshStandardMaterial, Texture } from 'three'
import { describe, expect, it } from 'vitest'
import { benchMaterial } from './workbenchModel'

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

  it('lays its cheeks over the skin as a see-through blush', () => {
    const blush = benchMaterial('blush', 'spool_blush_l', textures) as MeshStandardMaterial
    expect(blush.transparent).toBe(true)
    expect(blush.opacity).toBeLessThan(1)
  })
})
