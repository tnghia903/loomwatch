import { Color, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, PlaneGeometry, Texture } from 'three'
import { describe, expect, it } from 'vitest'

import { benchMaterial } from './workbenchModel'
import { FURNITURE, paintFurniture, type BenchFurniture, type BenchTone } from './workbenchScene'

// The bench's parts as the model makes them (workbench.glb's material roles), and a drawer's front,
// opening, box and foam as buildDrawer makes them.
const part = (role: string, name: string) => new Mesh(new PlaneGeometry(), benchMaterial(role, name, { pegboard: () => new Texture(), wound: null }))
const plain = (color: string) => new Mesh(new PlaneGeometry(), new MeshStandardMaterial({ color }))
const bench = (): BenchFurniture & { top: Mesh } => ({
  body: part('graphite', 'bench_body'),
  kick: part('shoe', 'bench_kick'),
  hooks: part('graphite', 'hooks_bar'),
  frame: part('pegboard', 'pegboard_panel'),
  face: part('pegboard', 'pegboard_face'),
  fronts: [0, 1].map(() => new Mesh(new PlaneGeometry(), new MeshPhysicalMaterial({ color: FURNITURE.dark.front }))),
  mouths: [0, 1].map(() => plain(FURNITURE.dark.mouth)),
  insides: [0, 1, 2].map(() => part('graphite', 'reads')),
  foams: [plain(FURNITURE.dark.foam)],
  top: part('benchtop', 'bench_top'),
})
const meshes = (parts: BenchFurniture) => [parts.body!, parts.kick!, parts.hooks!, parts.frame!, ...parts.fronts, ...parts.mouths, ...parts.insides, ...parts.foams]
const colors = (parts: BenchFurniture) => meshes(parts).map((mesh) => (mesh.material as MeshStandardMaterial).color.getHexString())
const light = (mesh: Mesh) => { const { r, g, b } = (mesh.material as MeshStandardMaterial).color; return 0.2126 * r + 0.7152 * g + 0.0722 * b }

describe('the bench in the light theme', () => {
  const boards = new Map<BenchTone, Texture>([['dark', new Texture()], ['light', new Texture()]])
  const board = (tone: BenchTone) => boards.get(tone)!

  it('is warm stone, drawers and all, lighter than obsidian but still darker than its top, and goes back to the model as made', () => {
    const parts = bench()
    const made = colors(parts)
    const dark = FURNITURE.dark
    expect(made).toEqual([dark.body, dark.kick, dark.hooks, dark.frame, dark.front, dark.front, dark.mouth, dark.mouth, dark.inside, dark.inside, dark.inside, dark.foam].map((hex) => new Color(hex).getHexString()))

    paintFurniture(parts, 'light', board)
    const painted = colors(parts)
    painted.forEach((hex, index) => expect(hex, `part ${index}`).not.toBe(made[index]))
    for (const mesh of [parts.body!, parts.kick!, parts.frame!, ...parts.fronts, ...parts.insides]) {
      expect(light(mesh)).toBeGreaterThan(0.15)
      expect(light(mesh)).toBeLessThan(light(parts.top))
    }
    // The openings, the key bar and the foam stay the deepest parts, but stone, not black.
    for (const mesh of [parts.hooks!, ...parts.mouths, ...parts.foams]) {
      expect(light(mesh)).toBeGreaterThan(0.05)
      expect(light(mesh)).toBeLessThan(light(parts.body!))
    }
    expect((parts.face!.material as MeshStandardMaterial).map).toBe(board('light'))

    paintFurniture(parts, 'dark', board)
    expect(colors(parts)).toEqual(made)
    expect((parts.face!.material as MeshStandardMaterial).map).toBe(board('dark'))
  })
})
