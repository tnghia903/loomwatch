import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { BoxGeometry, BufferAttribute, BufferGeometry, Color, CylinderGeometry, DirectionalLight, MeshPhysicalMaterial, MeshStandardMaterial, Object3D, Quaternion, Scene, SkinnedMesh, Texture, Vector3, WebGLRenderTarget, Mesh, SphereGeometry } from 'three'
import { describe, expect, it, vi } from 'vitest'
import { benchMaterial, bendClothes, CANVAS_PIXELS, clearFace, coveredBy, coverPile, dressWear, fitCanvas, pileMean, poseClothes, paintSkin, renewShadows, SHEEN_TOWARD_WHITE, furCoat, shineWithEyes, showPile, stripeHeights, velvetColor, wearMaterial } from './workbenchModel'

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

  it('tints the pile sheen toward the figure colour, not plain white, as the fibres of the stills catch the light', () => {
    const skin = benchMaterial('skin', 'skin', textures) as MeshPhysicalMaterial
    const lilac = velvetColor('lilac')
    paintSkin(skin, lilac)
    expect(skin.color.getHexString()).toBe(lilac.getHexString())
    expect(skin.sheenColor.getHexString()).toBe(lilac.clone().lerp(new Color('#FFFFFF'), SHEEN_TOWARD_WHITE).getHexString())
    expect(skin.sheenColor.getHexString()).not.toBe('ffffff')
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

describe('the live figure’s velvet pile', () => {
  it('is shells of each velvet part, its own shape a step further out each, in its own colour', () => {
    const part = new Mesh(new SphereGeometry(0.2), benchMaterial('skin', 'torso', { pegboard: () => new Texture(), wound: null }))
    const shells = furCoat(part, { shells: 6 })
    expect(shells).toHaveLength(6)
    expect(part.children).toEqual(shells)
    for (const shell of shells) expect(shell.geometry).toBe(part.geometry)
    // Painting the part paints its pile: the shells hold the very colour it holds.
    paintSkin(part.material as never, new Color('#5C8BB2'))
    for (const shell of shells) expect((shell.material as unknown as { color: Color }).color.getHexString()).toBe('5c8bb2')
    // No strand grows where the part is covered (coverPile): each point's cover, 0 until clothes lie on it.
    expect(Array.from(part.geometry.getAttribute('pileCover').array)).toEqual(new Array(part.geometry.getAttribute('position').count).fill(0))
    const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <color_fragment>' }
    ;(shells[0].material as MeshPhysicalMaterial).onBeforeCompile(shader as never, undefined as never)
    expect(shader.vertexShader).toContain('vPileCover = pileCover;')
    // Shorter where partly covered, none where wholly.
    expect(shader.fragmentShader).toContain('if (pileHeight > 1.0 - vPileCover')
  })

  it('draws soft strands, layer over layer, combed down the surface, with darker roots', () => {
    const part = new Mesh(new SphereGeometry(0.2), benchMaterial('skin', 'torso', { pegboard: () => new Texture(), wound: null }))
    const shells = furCoat(part)
    // Blended, each over the one under it: a strand's edge is soft, not cut hard into static.
    shells.forEach((shell, i) => {
      const material = shell.material as MeshPhysicalMaterial
      expect(material.transparent).toBe(true)
      expect(material.depthWrite).toBe(false)
      expect(shell.renderOrder).toBe(i + 1)
    })
    const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <color_fragment>' }
    ;(shells.at(-1)!.material as MeshPhysicalMaterial).onBeforeCompile(shader as never, undefined as never)
    // Leaning down the surface toward the tips, as the stills' fur lies, rather than standing straight out.
    expect(shader.uniforms.pileComb.value).toBeGreaterThan(0.5)
    expect(shader.vertexShader).toContain('pileDown * pileComb * pileHeight')
    expect(shader.fragmentShader).toContain('diffuseColor.a *= pileAlpha')
    const shade = shader.uniforms.pileShade.value as { x: number; y: number }
    expect(shade.x).toBeLessThan(0.8)
    expect(shade.y).toBeGreaterThan(1)
    expect(part.userData.pileComb).toBe(shader.uniforms.pileComb.value)
  })

  it('averages the strands where they are finer than a pixel: thickest at the roots, none at the tips', () => {
    expect(pileMean(0)).toBeGreaterThan(pileMean(0.5))
    expect(pileMean(0.5)).toBeGreaterThan(0)
    expect(pileMean(1)).toBe(0)
    // As a sum of the strands' round cuts: at the roots every strand stands, π w² of a cell each.
    expect(pileMean(0, 0.4)).toBeCloseTo(Math.PI * 0.16, 5)
  })
})

describe('clearFace', () => {
  it('shortens the pile round the eyes, nose and mouth, so they sit clear on the velvet, and leaves it long elsewhere', () => {
    const figure = new Object3D()
    const head = new Object3D()
    head.name = 'head'
    figure.add(head)
    const face = new Mesh(new SphereGeometry(0.25, 48, 32), new MeshPhysicalMaterial({ name: 'skin' }))
    face.name = 'head_mesh'
    head.add(face)
    furCoat(face, { shells: 2 })
    const eye = new Mesh(new SphereGeometry(0.03), new MeshPhysicalMaterial())
    eye.name = 'figure_eye_l'
    eye.position.set(0.08, 0.05, 0.24)
    head.add(eye)
    clearFace(figure)
    const cover = face.geometry.getAttribute('pileCover')
    const position = face.geometry.getAttribute('position')
    const at = new Vector3()
    let near = 0
    let far = 0
    for (let i = 0; i < position.count; i++) {
      at.fromBufferAttribute(position, i)
      const d = at.distanceTo(eye.position)
      if (d < 0.03) near = Math.max(near, cover.getX(i))
      if (d > 0.12) far = Math.max(far, cover.getX(i))
    }
    expect(near).toBeGreaterThan(0.8)
    expect(far).toBe(0)
  })
})

describe('a live figure’s eyes', () => {
  it('shut their shine with them: a blink squashes each eye, and its shine goes with it, staying where it was', () => {
    // As a build's glb holds them: each eye and its shine side by side on the head.
    const figure = new Object3D()
    const head = new Object3D()
    head.position.set(0, 1, 0)
    figure.add(head)
    for (const [side, x] of [['l', -0.1], ['r', 0.1]] as const) {
      const eye = new Object3D()
      eye.name = `figure_eye_${side}`
      eye.position.set(x, 0, 0.2)
      const glint = new Object3D()
      glint.name = `glint_${side}`
      glint.position.set(x + 0.01, 0.02, 0.21)
      head.add(eye, glint)
    }
    figure.updateMatrixWorld(true)
    const before = figure.getObjectByName('glint_l')!.getWorldPosition(new Vector3())

    shineWithEyes(figure)
    figure.updateMatrixWorld(true)
    expect(figure.getObjectByName('glint_l')!.getWorldPosition(new Vector3()).distanceTo(before)).toBeLessThan(1e-9)

    for (const side of ['l', 'r']) figure.getObjectByName(`figure_eye_${side}`)!.scale.y = 0.1
    figure.updateMatrixWorld(true)
    const shine = new Vector3()
    figure.getObjectByName('glint_r')!.matrixWorld.decompose(new Vector3(), new Quaternion(), shine)
    expect(shine.y).toBeCloseTo(0.1)
    // Flat on the eye, so on a head turned aside it doesn't stand past the eye's edge.
    expect(shine.z).toBeLessThan(0.5)
  })
})

describe('what a live figure wears', () => {
  const piece = (role: string, color = '#B9A27F') => new MeshStandardMaterial({ name: role, color, roughness: 0.7 })

  it('shows each garment’s weave close up: knit loops on the knits, a twill on the coat, a fine crepe on the dress', () => {
    const woven = (role: string) => dressWear(new Mesh(new BoxGeometry(), piece(role)))
    expect(woven('wear_cardigan').customProgramCacheKey()).toBe('cloth-knit')
    expect(woven('wear_trench_coat').customProgramCacheKey()).toBe('cloth-twill')
    expect(woven('wear_black_dress').customProgramCacheKey()).toBe('cloth-crepe')
    // Leather, a cup and pearls have none.
    expect(woven('wear_ballet_flats').customProgramCacheKey()).not.toContain('cloth')
    const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <color_fragment>' }
    woven('wear_cardigan').onBeforeCompile(shader as never, undefined as never)
    // A tone in the cloth's colour only, faded where a loop is finer than a few pixels; never a bump
    // in its light, which drew dark specks at the loops' edges.
    expect(shader.fragmentShader).toContain('clothFade(clothQ)')
    expect(shader.fragmentShader).not.toContain('normal =')
  })

  it('is cloth, felt or patent as the piece is, not the model’s plastic: knits and felt matte under a sheen, the flats polished', () => {
    const cardigan = wearMaterial(piece('wear_cardigan', '#B8546A'))
    expect(cardigan.roughness).toBeGreaterThanOrEqual(0.9)
    expect(cardigan.sheen).toBeGreaterThan(0.5)
    expect(cardigan.color.getHexString()).toBe(new Color('#B8546A').getHexString())
    const flats = wearMaterial(piece('wear_ballet_flats', '#1D1C22'))
    expect(flats.roughness).toBeLessThan(0.5)
    expect(flats.clearcoat).toBeGreaterThan(0.5)
    const beret = wearMaterial(piece('wear_beret', '#AD9C84'))
    expect(beret.roughness).toBeGreaterThanOrEqual(0.9)
    expect(beret.sheen).toBeGreaterThan(0.5)
  })

  it('draws the striped top’s stripes from each point’s height on the figure, sharp, not from its vertex colours, which blur on a light mesh', () => {
    // A top on a body node raised 0.4 in the figure, its points at heights 0, 0.05 and 0.1 on it.
    const figure = new Object3D()
    const body = new Object3D()
    body.position.y = 0.4
    figure.add(body)
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 0, 0.05, 0, 0, 0.1, 0]), 3))
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(9).fill(0.5), 3))
    const top = new Mesh(geometry, new MeshStandardMaterial({ name: 'wear_striped_top', vertexColors: true }))
    top.userData.stripes = 20
    body.add(top)

    stripeHeights(top, figure)
    expect([...(geometry.getAttribute('stripeAt').array as Float32Array)].map((at) => +at.toFixed(4))).toEqual([8, 9, 10])

    const knit = dressWear(top)
    expect(knit.vertexColors).toBe(false)
    expect(knit.customProgramCacheKey()).toBe('cloth-striped-knit')
    expect(knit.defines?.CLOTH_STRIPES).toBe('')
    // A piece with no stripes keeps its own colours.
    const plain = new Mesh(new BoxGeometry(), new MeshStandardMaterial({ name: 'wear_collar' }))
    stripeHeights(plain, figure)
    expect(plain.geometry.getAttribute('stripeAt')).toBeUndefined()
    expect(dressWear(plain).customProgramCacheKey()).not.toContain('striped')
  })

  it('puts a part’s pile away while shoes or gloves cover it, and back when they come off', () => {
    const figure = new Object3D()
    const part = (name: string) => {
      const mesh = new Mesh(new SphereGeometry(0.1), new MeshPhysicalMaterial({ name: 'skin' }))
      mesh.name = name
      figure.add(mesh)
      return furCoat(mesh, { shells: 2 })
    }
    const foot = part('foot_l')
    const paw = part('hand_l_mitten')
    showPile(figure, coveredBy(['ballet_flats', 'collar']))
    expect(foot.every((coat) => !coat.visible)).toBe(true)
    expect(paw.every((coat) => coat.visible)).toBe(true)
    showPile(figure, coveredBy([]))
    expect(foot.every((coat) => coat.visible)).toBe(true)
  })

  it('puts no part’s pile away whole for a garment, which clears it only where it lies (coverPile)', () => {
    expect(coveredBy(['striped_top', 'cardigan', 'trench_coat', 'black_dress']).size).toBe(0)
  })
})

describe('coverPile', () => {
  // A figure as the pipeline's glb lays it out, in velvet: a body round as a ball and a left arm
  // hanging from its shoulder, each with its pile.
  function velvet() {
    const root = new Object3D()
    root.name = 'figure'
    const body = new Object3D()
    body.name = 'body'
    root.add(body)
    const torso = new Mesh(new SphereGeometry(0.2, 32, 24), new MeshPhysicalMaterial({ name: 'skin' }))
    torso.name = 'torso'
    body.add(torso)
    const arm = new Object3D()
    arm.name = 'arm_l'
    arm.position.set(0.3, 0.1, 0)
    body.add(arm)
    const armShape = new CylinderGeometry(0.05, 0.05, 0.2, 16, 20, true).translate(0, -0.1, 0)
    const armMesh = new Mesh(armShape, new MeshPhysicalMaterial({ name: 'skin' }))
    armMesh.name = 'arm_l_mesh'
    arm.add(armMesh)
    for (const part of [torso, armMesh]) furCoat(part, { shells: 2 })
    return { root, body, torso, arm, armMesh }
  }
  // What a part's pile reads, point by point: 1 under the cloth.
  const cover = (part: Mesh) => (part.children[0] as Mesh).geometry.getAttribute('pileCover') as BufferAttribute
  const points = (part: Mesh, keep: (at: Vector3) => boolean) => {
    const position = part.geometry.getAttribute('position')
    return Array.from({ length: position.count }, (_, i) => i).filter((i) => keep(new Vector3().fromBufferAttribute(position, i)))
  }
  // A garment's body: a tube round the ball's middle, open at both ends, from y -0.15 to 0.05.
  function top(body: Object3D, name = 'wear_striped_top') {
    const garment = new Mesh(new CylinderGeometry(0.215, 0.215, 0.2, 48, 8, true).translate(0, -0.05, 0), new MeshStandardMaterial())
    garment.name = name
    body.add(garment)
    return garment
  }

  it('clears the pile where the garment lies over the body and nowhere else: the neck over its neckline keeps it', () => {
    const { root, body, torso } = velvet()
    const garment = top(body)
    coverPile(root, garment)
    const pile = cover(torso)
    // The pile reads the part's own cover, its shells sharing it.
    expect(torso.children.every((shell) => (shell as Mesh).geometry === torso.geometry)).toBe(true)
    const middle = points(torso, (at) => Math.abs(at.y) < 0.03)
    const neck = points(torso, (at) => at.y > 0.12)
    expect(middle.length).toBeGreaterThan(20)
    expect(neck.length).toBeGreaterThan(20)
    expect(middle.every((i) => pile.getX(i) === 1)).toBe(true)
    expect(neck.every((i) => pile.getX(i) === 0)).toBe(true)
    // Taken off, the pile grows all over.
    coverPile(root, null)
    expect(Array.from(pile.array).every((v) => v === 0)).toBe(true)
  })

  it('clears the pile whose strands, combed down, lean in under the cloth’s edge', () => {
    const lean = velvet()
    const flat = velvet()
    // The same figure with its strands standing straight out.
    flat.torso.userData.pileComb = 0
    for (const { root, body } of [lean, flat]) coverPile(root, top(body))
    // Just over the garment's top edge (0.05), the strands lean down under it.
    const above = points(lean.torso, (at) => at.y > 0.05 && at.y < 0.08)
    expect(above.length).toBeGreaterThan(5)
    expect(above.some((i) => cover(lean.torso).getX(i) === 1)).toBe(true)
    expect(above.every((i) => cover(flat.torso).getX(i) === 0)).toBe(true)
  })

  it('keeps the pile under cloth that stands further off than its strands reach, where you see under it', () => {
    const { root, body, torso } = velvet()
    const loose = new Mesh(new CylinderGeometry(0.26, 0.26, 0.2, 48, 8, true).translate(0, -0.05, 0), new MeshStandardMaterial())
    loose.name = 'wear_trench_coat'
    body.add(loose)
    coverPile(root, loose)
    const middle = points(torso, (at) => Math.abs(at.y) < 0.03)
    expect(middle.every((i) => cover(torso).getX(i) === 0)).toBe(true)
  })

  it('keeps the pile of a part in front of the cloth, whose way back meets the cloth’s outside', () => {
    const { root, body, armMesh, arm } = velvet()
    // The arm hangs at x 0.28, its inner side (x 0.23) just outside a body garment's side at 0.215:
    // points there face the cloth, from outside it, well within a strand's reach.
    arm.position.x = 0.28
    arm.rotation.set(0, 0, 0)
    const garment = top(body)
    coverPile(root, garment)
    const facing = points(armMesh, (at) => at.x < -0.03 && at.y < -0.02 && at.y > -0.18)
    expect(facing.length).toBeGreaterThan(5)
    expect(facing.every((i) => cover(armMesh).getX(i) === 0)).toBe(true)
  })

  it('clears an arm under its sleeve as the garment was made for the arm, and grows it past the cuff', () => {
    const { root, body, arm, armMesh } = velvet()
    // A sleeve made with the arm held forward (a quarter turn), over its first half: from the shoulder
    // 0.1 forward.
    const sleeve = new Mesh(new CylinderGeometry(0.06, 0.06, 0.1, 16, 2, true).rotateX(Math.PI / 2).translate(0.3, 0.1, 0.05), new MeshStandardMaterial())
    sleeve.name = 'wear_striped_top_pose_ask'
    sleeve.userData = { pose: 'ask', bind_arm_l: [-Math.PI / 2, 0, 0], bind_arm_r: [0, 0, 0] }
    body.add(sleeve)
    // The arm hangs now; the garment shown is the one made for it held forward.
    arm.rotation.set(0, 0, 0)
    coverPile(root, sleeve)
    const pile = cover(armMesh)
    const under = points(armMesh, (at) => at.y < -0.015 && at.y > -0.085)
    const past = points(armMesh, (at) => at.y < -0.12)
    expect(under.every((i) => pile.getX(i) === 1)).toBe(true)
    expect(past.every((i) => pile.getX(i) === 0)).toBe(true)
    expect(arm.rotation.x).toBe(0)
  })

  it('follows the garment shown for the arms’ pose (poseClothes)', () => {
    const { root, body, arm, armMesh } = velvet()
    // Made hanging: a sleeve over the whole arm. Made held forward: a sleeve over its first half.
    const hanging = new Mesh(new CylinderGeometry(0.06, 0.06, 0.2, 16, 2, true).translate(0.3, 0, 0), new MeshStandardMaterial())
    hanging.name = 'wear_striped_top_pose_down'
    hanging.userData = { pose: 'down', bind_arm_l: [0, 0, 0], bind_arm_r: [0, 0, 0] }
    const forward = new Mesh(new CylinderGeometry(0.06, 0.06, 0.1, 16, 2, true).rotateX(Math.PI / 2).translate(0.3, 0.1, 0.05), new MeshStandardMaterial())
    forward.name = 'wear_striped_top_pose_ask'
    forward.userData = { pose: 'ask', bind_arm_l: [-Math.PI / 2, 0, 0], bind_arm_r: [0, 0, 0] }
    body.add(hanging, forward)
    const armR = new Object3D()
    armR.name = 'arm_r'
    body.add(armR)
    const lower = points(armMesh, (at) => at.y < -0.12 && at.y > -0.185)
    arm.rotation.set(0, 0, 0)
    poseClothes(root)
    expect([hanging.visible, forward.visible]).toEqual([true, false])
    expect(lower.every((i) => cover(armMesh).getX(i) === 1)).toBe(true)
    arm.rotation.set(-Math.PI / 2, 0, 0)
    poseClothes(root)
    expect([hanging.visible, forward.visible]).toEqual([false, true])
    expect(lower.every((i) => cover(armMesh).getX(i) === 0)).toBe(true)
  })

  it('wears the clothes made with a paw up all the way up to a wave and back down, never those of a pose it passes (poseClothes)', () => {
    const root = new Object3D()
    const body = new Object3D()
    body.name = 'body'
    root.add(body)
    const arm = (side: 'l' | 'r') => Object.assign(new Object3D(), { name: `arm_${side}` })
    const armL = arm('l')
    const armR = arm('r')
    body.add(armL, armR)
    const made = (pose: string, right: number[]) => {
      const mesh = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial())
      mesh.name = `wear_cardigan_pose_${pose}`
      mesh.userData = { pose, bind_arm_l: [-1.42, 0, -0.05], bind_arm_r: right }
      body.add(mesh)
      return mesh
    }
    const rest = made('rest', [-1.42, 0, 0.05])
    const ask = made('ask', [-0.25, 0, -2.6])
    const failed = made('failed', [-1.1, 0, -0.5])
    const shown = () => [rest.visible, ask.visible, failed.visible]
    const atRest = { left: [-1.42, -0.05], right: [-1.42, 0.05] } as const
    const waving = { left: [-1.42, -0.05], right: [-0.25, -2.55] } as const
    armL.rotation.set(-1.42, 0, -0.05)
    armR.rotation.set(-1.42, 0, 0.05)
    poseClothes(body, atRest)
    expect(shown()).toEqual([true, false, false])
    // On its way up, the right arm nearest the pose made with the paws at the sides.
    armR.rotation.set(-1.1, 0, -0.6)
    poseClothes(body)
    expect(shown(), 'the nearest, with nowhere to go').toEqual([false, false, true])
    poseClothes(body, waving)
    expect(shown()).toEqual([false, true, false])
    armR.rotation.set(-0.25, 0, -2.55)
    poseClothes(body, waving)
    expect(shown()).toEqual([false, true, false])
    // On its way back down, past the paws-at-the-sides pose again: still the paw-up clothes.
    armR.rotation.set(-1.1, 0, -0.6)
    poseClothes(body, atRest)
    expect(shown()).toEqual([false, true, false])
    // Home: its own.
    armR.rotation.set(-1.42, 0, 0.05)
    poseClothes(body, atRest)
    expect(shown()).toEqual([true, false, false])
  })

  it('covers the parts a figure has now, when another build is shown in the same node', () => {
    const shown = new Object3D()
    const first = velvet()
    shown.add(first.root)
    coverPile(shown, top(first.body))
    // The bench empties its figure's node and fills it with the next build's parts.
    shown.remove(first.root)
    const next = velvet()
    shown.add(next.root)
    coverPile(shown, top(next.body))
    const middle = points(next.torso, (at) => Math.abs(at.y) < 0.03)
    expect(middle.every((i) => cover(next.torso).getX(i) === 1)).toBe(true)
  })

  it('gives each copy of a figure a cover of its own, as each wears its own clothes', () => {
    const { root, torso } = velvet()
    const copy = root.clone(true)
    top(copy.getObjectByName('body')!)
    coverPile(copy, copy.getObjectByName('wear_striped_top') as Mesh)
    coverPile(root, null)
    const middle = points(torso, (at) => Math.abs(at.y) < 0.03)
    const copyTorso = copy.getObjectByName('torso') as Mesh
    expect(middle.every((i) => cover(copyTorso).getX(i) === 1)).toBe(true)
    expect(middle.every((i) => cover(torso).getX(i) === 0)).toBe(true)
    expect(copyTorso.geometry).not.toBe(torso.geometry)
    expect(copyTorso.geometry.getAttribute('position')).toBe(torso.geometry.getAttribute('position'))
  })
})


describe('bendClothes', () => {
  // A figure as the pipeline's glb lays it out: body, shoulder and paw pivots, and a garment under the
  // body whose points say how much each follows an arm or a paw.
  function figure() {
    const root = new Object3D()
    root.name = 'figure'
    const body = new Object3D()
    body.name = 'body'
    root.add(body)
    for (const [side, x] of [['l', 0.17], ['r', -0.17]] as const) {
      const arm = new Object3D()
      arm.name = `arm_${side}`
      arm.position.set(x, 0.27, 0)
      const hand = new Object3D()
      hand.name = `hand_${side}`
      hand.position.set(0, -0.19, 0)
      arm.add(hand)
      body.add(arm)
    }
    // Three points: on the body, on the left sleeve at the paw, and on the left shoulder (half each).
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0.1, 0.2, 0.17, 0.08, 0, 0.17, 0.27, 0.05]), 3))
    geometry.setAttribute('_arm_l', new BufferAttribute(new Float32Array([0, 1, 0.5]), 1))
    for (const name of ['_arm_r', '_hand_l', '_hand_r']) geometry.setAttribute(name, new BufferAttribute(new Float32Array([0, 0, 0]), 1))
    const coat = new Mesh(geometry, new MeshStandardMaterial())
    coat.name = 'wear_trench_coat'
    body.add(coat)
    return root
  }

  function at(mesh: SkinnedMesh, index: number): Vector3 {
    return mesh.getVertexPosition(index, new Vector3())
  }

  it('makes a garment bend with the arms: a sleeve follows a raised arm, the body stays, the shoulder goes half way', () => {
    const root = figure()
    const [coat] = bendClothes(root)
    expect(coat).toBeInstanceOf(SkinnedMesh)
    expect(root.getObjectByName('wear_trench_coat')).toBe(coat)
    const rest = [0, 1, 2].map((i) => at(coat, i))
    // The left arm swings forward and up a quarter turn about its shoulder.
    root.getObjectByName('arm_l')!.rotation.set(-Math.PI / 2, 0, 0)
    root.updateMatrixWorld(true)
    const raised = [0, 1, 2].map((i) => at(coat, i))
    expect(raised[0].distanceTo(rest[0])).toBeLessThan(1e-6)
    // The sleeve's point at the paw: 0.19 below the shoulder at rest, 0.19 in front of it raised.
    expect(raised[1].y).toBeCloseTo(0.27, 5)
    expect(raised[1].z).toBeCloseTo(0.19, 5)
    // The shoulder's point moves, but less than a point the arm carries all of would.
    const carried = new Vector3(0.17, 0.27, 0.05).sub(new Vector3(0.17, 0.27, 0)).applyAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2).add(new Vector3(0.17, 0.27, 0))
    expect(raised[2].distanceTo(rest[2])).toBeGreaterThan(0.01)
    expect(raised[2].distanceTo(rest[2])).toBeLessThan(carried.distanceTo(rest[2]))
  })

  it('ties a garment to the arms as they were held when it was made, then puts the arms back', () => {
    const root = figure()
    const coat = root.getObjectByName('wear_trench_coat') as Mesh
    // Made with the left arm held a quarter turn forward: its paw point is in front of the shoulder.
    const position = coat.geometry.getAttribute('position') as BufferAttribute
    position.setXYZ(1, 0.17, 0.27, 0.19)
    coat.userData = { bind_arm_l: [-Math.PI / 2, 0, 0], bind_arm_r: [0, 0, 0] }
    const armL = root.getObjectByName('arm_l')!
    const [bent] = bendClothes(root)
    // The arm is back as it was, hanging, and the sleeve's point hangs with it.
    expect(armL.rotation.x).toBe(0)
    const hanging = at(bent, 1)
    expect(hanging.y).toBeCloseTo(0.08, 5)
    expect(hanging.z).toBeCloseTo(0, 5)
    // Held as it was made, the point is where the file put it.
    armL.rotation.set(-Math.PI / 2, 0, 0)
    root.updateMatrixWorld(true)
    expect(at(bent, 1).z).toBeCloseTo(0.19, 5)
  })

  it('reads the pulls from a garment’s texture coordinates, as the compressed landing page files carry them', () => {
    const root = figure()
    const coat = root.getObjectByName('wear_trench_coat') as Mesh
    for (const name of ['_arm_l', '_arm_r', '_hand_l', '_hand_r']) coat.geometry.deleteAttribute(name)
    // uv: (left arm, 1 - right arm), uv1: (left paw, 1 - right paw), as glTF turns v over.
    coat.geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 1, 1, 1, 0.5, 1]), 2))
    coat.geometry.setAttribute('uv1', new BufferAttribute(new Float32Array([0, 1, 0, 1, 0, 1]), 2))
    coat.userData = { bind_arm_l: [0, 0, 0], bind_arm_r: [0, 0, 0] }
    const [bent] = bendClothes(root)
    root.getObjectByName('arm_l')!.rotation.set(-Math.PI / 2, 0, 0)
    root.updateMatrixWorld(true)
    expect(at(bent, 0).z).toBeCloseTo(0.2, 5)
    expect(at(bent, 1).z).toBeCloseTo(0.19, 5)
  })

  it('leaves a mesh with texture coordinates but no pose it was made in as it is', () => {
    const root = figure()
    const coat = root.getObjectByName('wear_trench_coat') as Mesh
    for (const name of ['_arm_l', '_arm_r', '_hand_l', '_hand_r']) coat.geometry.deleteAttribute(name)
    coat.geometry.setAttribute('uv', new BufferAttribute(new Float32Array(6), 2))
    coat.geometry.setAttribute('uv1', new BufferAttribute(new Float32Array(6), 2))
    expect(bendClothes(root)).toEqual([])
  })

  it('shows a garment as it was made for the pose nearest the arms, each tied to the arms in its own pose', () => {
    const root = figure()
    const coat = root.getObjectByName('wear_trench_coat') as Mesh
    coat.name = 'wear_trench_coat_pose_rest'
    coat.userData = { pose: 'rest', bind_arm_l: [-1.4, 0, 0], bind_arm_r: [-1.4, 0, 0] }
    const raised = coat.clone()
    raised.geometry = coat.geometry.clone()
    raised.name = 'wear_trench_coat_pose_done'
    raised.userData = { pose: 'done', bind_arm_l: [-0.3, 0, 2.2], bind_arm_r: [-0.3, 0, -2.2] }
    coat.parent!.add(raised)
    const [atRest, up] = bendClothes(root)
    const armL = root.getObjectByName('arm_l')!
    const armR = root.getObjectByName('arm_r')!
    armL.rotation.set(-0.3, 0, 2.2)
    armR.rotation.set(-0.3, 0, -2.2)
    poseClothes(root)
    expect([atRest.visible, up.visible]).toEqual([false, true])
    armL.rotation.set(-1.3, 0, 0.1)
    armR.rotation.set(-1.3, 0, -0.1)
    poseClothes(root)
    expect([atRest.visible, up.visible]).toEqual([true, false])
    // Held as it was made, a garment is as its file has it: the raised one with both paws up.
    armL.rotation.set(-0.3, 0, 2.2)
    armR.rotation.set(-0.3, 0, -2.2)
    root.updateMatrixWorld(true)
    expect(at(up, 1).distanceTo(new Vector3(0.17, 0.08, 0))).toBeLessThan(1e-6)
    // Not worn, none shows.
    for (const mesh of [atRest, up]) mesh.userData.worn = false
    poseClothes(root)
    expect([atRest.visible, up.visible]).toEqual([false, false])
  })

  it('leaves a figure with no pulling garment as it is', () => {
    const root = figure()
    const coat = root.getObjectByName('wear_trench_coat') as Mesh
    coat.geometry.deleteAttribute('_arm_l')
    expect(bendClothes(root)).toEqual([])
    expect(root.getObjectByName('wear_trench_coat')).toBe(coat)
  })
})

describe('fitCanvas', () => {
  const sized = (ratio: number, width: number, height: number) => {
    vi.stubGlobal('devicePixelRatio', ratio)
    const renderer = { setDrawingBufferSize: vi.fn(), domElement: { style: {} as CSSStyleDeclaration } }
    fitCanvas(renderer as never, width, height)
    vi.unstubAllGlobals()
    return renderer.setDrawingBufferSize.mock.calls[0].slice(0, 2)
  }

  it('draws a small canvas at a 3x screen’s own pixels, zoomed in too, so its velvet stays sharp', () => {
    expect(sized(3, 1120, 240)).toEqual([3360, 720])
    expect(sized(4, 1120, 240)).toEqual([3360, 720])
  })

  it('keeps a large canvas at 2x, and draws at the screen’s own pixels up to that', () => {
    const [across, down] = sized(3, 1516, 1137)
    expect(across * down).toBeLessThanOrEqual(CANVAS_PIXELS * 1.34)
    expect([across, down]).toEqual([3032, 2274])
    expect(sized(1, 1120, 240)).toEqual([1120, 240])
    expect(sized(2, 1120, 240)).toEqual([2240, 480])
  })
})

describe('the pile’s strands (furCoat)', () => {
  it('stand on a lattice turned off the figure’s axes and gently bent, so no grid shows up close', () => {
    const part = new Mesh(new SphereGeometry(0.1, 8, 6), new MeshPhysicalMaterial())
    const [shell] = furCoat(part, { shells: 1 })
    const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <color_fragment>' }
    ;(shell.material as MeshPhysicalMaterial).onBeforeCompile(shader as never, undefined as never)
    expect(shader.fragmentShader).toContain('vec3 at = pileTurn * (vPileAt * pileDensity);')
    expect(shader.fragmentShader).toMatch(/at \+= [0-9.]+ \* sin\(/)
    const turn = /const mat3 pileTurn = mat3\(([^)]*)\)/.exec(shader.fragmentShader)
    expect(turn).not.toBeNull()
    const n = turn![1].split(',').map(Number)
    const columns = [n.slice(0, 3), n.slice(3, 6), n.slice(6, 9)].map(([x, y, z]) => new Vector3(x, y, z))
    // A turn: each column a unit long, square to the others, and none along an axis.
    for (const [i, column] of columns.entries()) {
      expect(column.length()).toBeCloseTo(1, 3)
      for (const other of columns.slice(i + 1)) expect(column.dot(other)).toBeCloseTo(0, 3)
      expect(Math.max(Math.abs(column.x), Math.abs(column.y), Math.abs(column.z))).toBeLessThan(0.9)
    }
  })
})
