import {
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Euler,
  HalfFloatType,
  Light,
  MathUtils,
  Matrix3,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PMREMGenerator,
  Quaternion,
  Skeleton,
  SkinnedMesh,
  Texture,
  Uint16BufferAttribute,
  Float32BufferAttribute,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type Camera,
  type LightShadow,
  type Bone,
  type Material,
  type Object3D,
  type Scene,
  type WebGLRenderer,
} from 'three'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

import { LIVE_HEX } from '../../lib/library/figureHex'
import type { FigureColor } from '../../lib/library/figures'

/*
 * What every scene drawn from workbench.glb shares: the app's bench (WorkbenchScene, in
 * workbenchScene.ts) and the landing page's crew and the figure on its pull cord (src/site/). It is
 * a module of its own so the page can draw the crew without loading the bench, which it draws
 * further down and loads when it gets there (src/site/landingLive.ts).
 */

/** The screen's blue, as the app's live state: the bench's app band and laptop screen glow it. */
export const LIVE = new Color('#6AB8FF')

/**
 * Size a renderer's canvas to its box in whole device pixels, and say the size in CSS pixels it
 * now draws at. A drawing buffer even part of a pixel smaller than the box it fills is stretched to
 * fit, which resamples the whole picture and leaves it soft, worst on a 1x screen. So the canvas
 * takes exactly the size of its buffer: at most a fraction of a pixel short of its box. Shared with
 * the landing page's crew (src/site/crewScene.ts).
 *
 * It draws at the screen's own pixels up to 2x, and up to 3x while the canvas stays within
 * CANVAS_PIXELS: zoomed in, a canvas held at 2x was stretched, and the velvet's strands went soft
 * and grainy. A large canvas (the bench filling a window) stays at 2x.
 */
/** The most device pixels a canvas is drawn with above 2x (fitCanvas): a crew's canvas at 3x. */
export const CANVAS_PIXELS = 6_000_000

export function fitCanvas(renderer: WebGLRenderer, width: number, height: number): { width: number; height: number } {
  const screen = window.devicePixelRatio || 1
  const room = Math.sqrt(CANVAS_PIXELS / Math.max(1, width * height))
  const ratio = Math.min(screen, Math.max(2, Math.min(3, room)))
  const across = Math.max(1, Math.floor(width * ratio))
  const down = Math.max(1, Math.floor(height * ratio))
  // In device pixels, at a ratio of 1: three floors width × ratio itself, which can land a pixel short.
  renderer.setDrawingBufferSize(across, down, 1)
  renderer.domElement.style.width = `${across / ratio}px`
  renderer.domElement.style.height = `${down / ratio}px`
  return { width: across / ratio, height: down / ratio }
}

/**
 * workbench.glb, from its URL, or from its bytes when the caller has fetched them already: the
 * landing page fetches the model once, alongside the code that draws it, and builds each of its
 * scenes from the same bytes. The page's copy is compressed (meshopt; site/build.sh makes it), so
 * this can decode that too; the app's own copy, public/agent/workbench.glb, is the model as made.
 */
export function readModel(source: string | ArrayBuffer): Promise<GLTF> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
  return typeof source === 'string' ? loader.loadAsync(source) : loader.parseAsync(source, '')
}

/**
 * Compile every shader `object` draws with, its hidden parts' too, and resolve once they can be
 * used; `scene` is the scene it draws in, when it is only part of one. A shader compiles the first
 * time a frame needs it, and that frame waits: on a visitor's first look, before the browser has
 * cached any of them, the bench's took seconds and held up the whole page. Where the browser can
 * compile in the background (KHR_parallel_shader_compile, in Chrome and Safari), this waits without
 * holding anything up; elsewhere it costs what the first frame would have.
 */
export async function readyToDraw(renderer: WebGLRenderer, object: Object3D, camera: Camera, scene: Scene | null = null): Promise<void> {
  const materials = renderer.compile(object, camera, scene)
  const programs = new Set([...materials].flatMap((material) => (renderer.properties.get(material) as Compiled).currentProgram ?? []))
  // What compileAsync() waits for; it doesn't say which programs it compiled.
  while (![...programs].every((program) => program.isReady())) await new Promise((resolve) => setTimeout(resolve, 10))
  // three asks after a program's uniforms the first time it draws with it, and the answer waits for
  // everything sent to the GPU before it: in a first frame, the textures going up and the draws
  // before it. Asked now, nothing is ahead of it. The textures go up now too: the first asks the
  // GPU how finely it may filter, and that answer waits the same way.
  for (const program of programs) program.getUniforms()
  for (const material of materials) for (const value of Object.values(material)) if (value instanceof Texture) renderer.initTexture(value)
}

/** A figure's colour as its live velvet is painted (LIVE_HEX): measured so that, lit, it shows as its still does. */
export function velvetColor(color: FigureColor): Color {
  return new Color(LIVE_HEX[color])
}

/**
 * The pile's lattice (furCoat), turned so none of its planes lies along the figure's axes: rows
 * (2, -1, -1), (0, 1, -1) and (1, 1, 1), each made a unit long. As GLSL, column by column.
 */
const PILE_TURN = 'mat3(0.8165, 0.0, 0.5774, -0.4082, 0.7071, 0.5774, -0.4082, -0.7071, 0.5774)'

/** How far, in cells, the pile's lattice is bent (furCoat). */
const PILE_BEND = 0.5

/** How far a skin's sheen goes from its own colour toward white. */
export const SHEEN_TOWARD_WHITE = 0.5

/**
 * The velvet pile on a live figure (the bench), as close to the stills' fur as a browser draws it: a
 * few shells of the part, each a step further out along its surface, keeping only the strands that
 * still reach that far, so the pile thins to soft tips; the roots darker than the tips, as the
 * stills' strands are. Each shell is a child of `mesh`, sharing its geometry and its colour (the very
 * Color objects its material holds), so painting the part paints its pile. `roots` and `tips` shade
 * the strands from the lowest shell to the highest, near alike: further apart (0.62 to 1.08), strands
 * a pixel or two wide read as static, and the colour measured for the velvet (LIVE_HEX) is for these.
 *
 * Each strand stands in a cell of a lattice turned off the figure's axes and gently bent
 * (PILE_TURN, PILE_BEND), thin enough (`width`) to stand well off its cell's middle. On a square lattice,
 * with strands near their cells' middles, a part facing the camera showed the lattice as a fine
 * woven grid when drawn up close.
 */
export function furCoat(mesh: Mesh, { shells = 20, length = 0.03, density = 380, width = 0.3, roots = 0.7, tips = 1.17, comb = 1.1 } = {}): Mesh[] {
  const base = mesh.material as MeshPhysicalMaterial
  const made: Mesh[] = []
  for (let i = 1; i <= shells; i += 1) {
    const height = i / shells
    // Blended, each a layer over the one under it (renderOrder), so a strand's edge is soft: cut
    // hard, strands two or three pixels wide shimmered as static and frayed the outline.
    const shell = new MeshPhysicalMaterial({ roughness: 0.95, specularIntensity: 0.5, sheen: 1, sheenRoughness: 0.5, transparent: true, depthWrite: false, envMapIntensity: VELVET_FILL })
    shell.color = base.color
    shell.sheenColor = base.sheenColor
    shell.name = 'pile'
    shell.onBeforeCompile = (shader) => {
      shader.uniforms.pileHeight = { value: height }
      shader.uniforms.pileLength = { value: length }
      shader.uniforms.pileComb = { value: comb }
      shader.uniforms.pileDensity = { value: density }
      shader.uniforms.pileShade = { value: new Vector2(roots, tips) }
      shader.uniforms.pileMean = { value: pileMean(height, width) }
      shader.uniforms.pileWidth = { value: width }
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float pileHeight;\nuniform float pileLength;\nuniform float pileComb;\nattribute float pileCover;\nvarying vec3 vPileAt;\nvarying vec3 vPileUp;\nvarying float vPileCover;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPileAt = position;\nvPileUp = objectNormal;\nvPileCover = pileCover;\nvec3 pileOut = normalize(objectNormal);\nvec3 pileDown = vec3(0.0, -1.0, 0.0) - pileOut * -pileOut.y;\npileDown *= min(1.0, length(pileDown) * 4.0) / max(length(pileDown), 1e-4);\ntransformed += (pileOut + pileDown * pileComb * pileHeight) * pileHeight * pileLength;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float pileHeight;\nuniform float pileDensity;\nuniform vec2 pileShade;\nuniform float pileMean;\nuniform float pileWidth;\nvarying vec3 vPileAt;\nvarying vec3 vPileUp;\nvarying float vPileCover;\nfloat pileHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }\nconst mat3 pileTurn = ' + PILE_TURN + ';')
        .replace('#include <color_fragment>', `#include <color_fragment>
          // One strand per cell, round, of its own length; thinner the higher the shell.
          vec3 at = pileTurn * (vPileAt * pileDensity);
          // Bent a little, slowly, so its rows run in soft waves, not straight lines.
          at += ${PILE_BEND.toFixed(2)} * sin(at.yzx * 0.29 + 2.0 * sin(at.zxy * 0.17));
          vec3 cell = floor(at);
          // Each strand off its cell's middle by its own amount, so the pile shows no grid.
          vec3 jitter = vec3(pileHash(cell + 1.3), pileHash(cell + 2.7), pileHash(cell + 4.1)) - 0.5;
          vec3 inCell = fract(at) - 0.5 - (0.95 - 2.0 * pileWidth) * jitter;
          // Across the surface only: through the cells' layers, the strands thinned where a layer
          // ended, in rings round wherever the surface lay flat to them (the middle of the face).
          vec3 up = normalize(pileTurn * vPileUp);
          inCell -= up * dot(inCell, up);
          float reach = 0.35 + 0.65 * pileHash(cell);
          float radius = pileHeight < reach ? pileWidth * (1.0 - pileHeight / reach) : 0.0;
          // Its edge soft over a pixel, measured across the strands (the outline, where the shells are
          // seen edge on, stretches them the other way); where they are finer than about half a pixel
          // (far off), what they average to there.
          float span = max(min(length(dFdx(at)), length(dFdy(at))), 1e-4);
          float strand = radius > 0.0 ? clamp((radius - length(inCell)) / span + 0.5, 0.0, 1.0) : 0.0;
          float pileAlpha = mix(strand, pileMean, smoothstep(1.4, 2.8, span));
          // Shorter where the part is partly covered (round the face's features, clearFace), none
          // where clothes lie over it (coverPile).
          if (pileHeight > 1.0 - vPileCover || pileAlpha < 0.01) discard;
          diffuseColor.a *= pileAlpha;
          // Darker at the roots, lighter at the tips, a little different strand to strand.
          diffuseColor.rgb *= mix(pileShade.x, pileShade.y, pileHeight) * (0.92 + 0.16 * pileHash(cell + 7.0));`)
    }
    // One program for every shell: only its height (a uniform) differs, so it compiles once.
    shell.customProgramCacheKey = () => 'velvet-pile'
    const coat = new Mesh(mesh.geometry, shell)
    if (i === 1 && !mesh.geometry.getAttribute('pileCover')) mesh.geometry.setAttribute('pileCover', new BufferAttribute(new Float32Array(mesh.geometry.getAttribute('position').count), 1))
    coat.name = `${mesh.name}_pile${i}`
    // How far its strands reach, so clothes clear only the pile that would stand through them (coverPile).
    mesh.userData.pileLength = length
    mesh.userData.pileComb = comb
    coat.castShadow = false
    coat.receiveShadow = true
    // Drawn root shells first, every part's, so each layer lies over the ones under it.
    coat.renderOrder = i
    mesh.add(coat)
    made.push(coat)
  }
  return made
}

/** The face's features, each with how much of the pile round it is cleared (clearFace). */
const FACE_CLEAR: Record<string, number> = { figure_eye_l: 0.9, figure_eye_r: 0.9, nose: 0.8, mouth: 0.7, brow_l: 0.55, brow_r: 0.55 }

/**
 * Short pile round the face's features, as the stills keep it, so the eyes, nose, mouth and brows sit
 * clear on the velvet: at full length the strands stood over the eyes' rims and frayed them. Each
 * point of the head within a feature's reach gives up that much of its pile (`pileCover`), easing
 * back to full a little further out. Call it on a figure at rest once its pile is on (furCoat).
 */
export function clearFace(figure: Object3D) {
  const head = figure.getObjectByName('head_mesh')
  const cover = head instanceof Mesh ? head.geometry.getAttribute('pileCover') : undefined
  if (!(head instanceof Mesh) || !cover) return
  figure.updateMatrixWorld(true)
  const toHead = new Matrix4().copy(head.matrixWorld).invert()
  const features: { at: Vector3; radius: number; clear: number }[] = []
  for (const [name, clear] of Object.entries(FACE_CLEAR)) {
    const part = figure.getObjectByName(name)
    if (!(part instanceof Mesh)) continue
    part.geometry.computeBoundingSphere()
    const sphere = part.geometry.boundingSphere!.clone().applyMatrix4(new Matrix4().multiplyMatrices(toHead, part.matrixWorld))
    features.push({ at: sphere.center, radius: sphere.radius, clear })
  }
  const position = head.geometry.getAttribute('position')
  const at = new Vector3()
  for (let i = 0; i < position.count; i++) {
    at.fromBufferAttribute(position, i)
    let clear = cover.getX(i)
    for (const feature of features) {
      const out = (at.distanceTo(feature.at) - feature.radius) / (feature.radius * 0.8 + 0.012)
      clear = Math.max(clear, feature.clear * (1 - MathUtils.smoothstep(out, 0, 1)))
    }
    cover.setX(i, clear)
  }
  cover.needsUpdate = true
}

/**
 * How much of the room's even light the velvet takes, against the key light: at full, the head was lit
 * the same all round and read flat, where its stills shade it from the light to the far side.
 */
export const VELVET_FILL = 0.45

/**
 * How much of a shell at `height` (0 at the roots, 1 at the tips) the strands cover on average: each
 * strand's reach is even between 0.35 and 1 of the pile's length, and its round cut π r², r = `width`
 * (1 - height / reach) in cells. The shells draw this where the strands are finer than a pixel.
 */
export function pileMean(height: number, width = 0.5): number {
  const from = Math.max(height, 0.35)
  if (from >= 1) return 0
  const integral = (reach: number) => reach - 2 * height * Math.log(reach) - (height * height) / reach
  return ((Math.PI * width * width) / 0.65) * (integral(1) - integral(from))
}

/** How deep an eye's shine is drawn, of its own depth (shineWithEyes). */
const GLINT_DEPTH = 0.3

/**
 * Hang each eye's shine (glint_l, glint_r) on its eye, where it stays in place, so a blink, which
 * squashes the eyes, shuts the shine with them: a build's figure keeps them side by side.
 */
export function shineWithEyes(figure: Object3D) {
  for (const side of ['l', 'r']) {
    const eye = figure.getObjectByName(`figure_eye_${side}`)
    const glint = figure.getObjectByName(`glint_${side}`)
    if (eye && glint && glint.parent !== eye) {
      figure.updateMatrixWorld(true)
      eye.attach(glint)
      // Flat on the eye, as a shine is: a bead centred on its surface, half of it stood out, and on a
      // head turned aside it showed past the eye's edge.
      glint.scale.z *= GLINT_DEPTH
    }
  }
}

/**
 * Colour a figure's skin: the colour itself (velvetColor, which the caller has chosen), and the
 * pile's sheen a pale tint of it, as the stills' fibres catch the light in their own colour. A white
 * sheen laid a cream veil over the sides and caught the cool rim light under the chin.
 */
export function paintSkin(material: Material, color: Color) {
  const skin = material as MeshPhysicalMaterial
  skin.color.copy(color)
  if (skin.isMeshPhysicalMaterial) skin.sheenColor.copy(color).lerp(WHITE, SHEEN_TOWARD_WHITE)
}

const WHITE = new Color('#FFFFFF')

/**
 * How each wardrobe piece catches the light on a live figure: knits and cloth matte under a soft
 * sheen, silk and satin brighter, the flats and the cup's lid polished. The model's own
 * material (glTF's default, rough plastic) read as a shiny shell.
 */
const FINISH: Record<string, { roughness: number; sheen?: number; sheenRoughness?: number; clearcoat?: number; specularIntensity?: number }> = {
  wear_striped_top: { roughness: 0.95, sheen: 0.6, sheenRoughness: 0.6, specularIntensity: 0.2 },
  wear_cardigan: { roughness: 0.95, sheen: 0.9, sheenRoughness: 0.5, specularIntensity: 0.2 },
  wear_beret: { roughness: 0.95, sheen: 0.7, sheenRoughness: 0.55, specularIntensity: 0.2 },
  wear_gloves: { roughness: 0.9, sheen: 0.6, sheenRoughness: 0.5, specularIntensity: 0.25 },
  wear_trench_coat: { roughness: 0.82, sheen: 0.3, sheenRoughness: 0.6, specularIntensity: 0.3 },
  wear_black_dress: { roughness: 0.6, sheen: 0.6, sheenRoughness: 0.4, specularIntensity: 0.4 },
  wear_bow: { roughness: 0.5, sheen: 0.7, sheenRoughness: 0.35, specularIntensity: 0.45 },
  wear_collar: { roughness: 0.5, sheen: 0.6, sheenRoughness: 0.35, specularIntensity: 0.45 },
  wear_silk_scarf: { roughness: 0.45, sheen: 1, sheenRoughness: 0.3, specularIntensity: 0.5 },
  wear_coffee: { roughness: 0.45, clearcoat: 0.5, specularIntensity: 0.5 },
  wear_ballet_flats: { roughness: 0.4, clearcoat: 0.6, specularIntensity: 0.5 },
}

/** A wardrobe piece's material on a live figure: the model's colour for it, in its finish (FINISH). */
export function wearMaterial(from: Material): MeshPhysicalMaterial {
  const finish = FINISH[from.name] ?? { roughness: 0.85 }
  const made = new MeshPhysicalMaterial({
    color: (from as MeshStandardMaterial).color ?? WHITE,
    roughness: finish.roughness,
    metalness: 0,
    sheen: finish.sheen ?? 0,
    sheenRoughness: finish.sheenRoughness ?? 0.5,
    clearcoat: finish.clearcoat ?? 0,
    clearcoatRoughness: 0.2,
    specularIntensity: finish.specularIntensity ?? 0.4,
    vertexColors: (from as MeshStandardMaterial).vertexColors,
    side: DoubleSide,
  })
  made.sheenColor.copy(made.color).lerp(WHITE, 0.35)
  made.name = from.name
  return made
}

/**
 * Give a striped piece (its glb names `stripes`, the stripes per unit of the figure's height) each
 * point's height on the figure in stripes, `stripeAt`, measured as it stands in the model: the
 * stripes run level round the body, as the stills draw them. Its vertex colours had them, but a mesh
 * as light as the bench's blurs them grey. Call it on the build's own model, before any pose.
 */
export function stripeHeights(mesh: Mesh, figure: Object3D) {
  const perUnit = mesh.userData.stripes
  if (typeof perUnit !== 'number' || mesh.geometry.getAttribute('stripeAt')) return
  figure.updateWorldMatrix(true, true)
  const toFigure = figure.matrixWorld.clone().invert().multiply(mesh.matrixWorld)
  const position = mesh.geometry.getAttribute('position')
  const at = new Float32Array(position.count)
  const point = new Vector3()
  for (let i = 0; i < position.count; i += 1) at[i] = point.fromBufferAttribute(position, i).applyMatrix4(toFigure).y * perUnit
  mesh.geometry.setAttribute('stripeAt', new BufferAttribute(at, 1))
}

/**
 * The weave each garment shows close up (weaveCloth), as its stills' cloth: knit loops (a stocking
 * stitch's columns of V's), a twill's diagonal ribs or a crepe's fine grain, so many to a unit of the
 * figure across and down, and how deep they stand.
 */
const WEAVES: Record<string, { kind: 'knit' | 'twill' | 'crepe'; across: number; down: number; depth: number }> = {
  wear_striped_top: { kind: 'knit', across: 82, down: 104, depth: 1 },
  wear_cardigan: { kind: 'knit', across: 58, down: 72, depth: 1.25 },
  wear_beret: { kind: 'crepe', across: 260, down: 260, depth: 0.6 },
  wear_trench_coat: { kind: 'twill', across: 150, down: 150, depth: 0.5 },
  wear_black_dress: { kind: 'crepe', across: 240, down: 240, depth: 0.35 },
}
const WEAVE_KIND = { knit: 1, twill: 2, crepe: 3 }

/**
 * Cloth close up: its weave (WEAVES) a little lighter on the yarn and darker in the hollows, shown only
 * where each loop or thread spans a few pixels (a large bench), so it never shimmers (raised in the
 * light as well, its loops' edges tilted the cloth away from it in dark specks); a striped piece's stripes (stripeHeights)
 * drawn sharp at any size, ink from 0.62 of each stripe on, as its stills, each edge eased over a
 * pixel (eased on one side only, the other edge stepped). The weave follows the cloth as made (its
 * points before the arms bend it), so it stays put as the arms move.
 */
export function weaveCloth(material: MeshPhysicalMaterial, striped = false, ivory = '#EEE8DE', ink = '#1D1C22') {
  const weave = WEAVES[material.name]
  if (striped) material.vertexColors = false
  if (!weave && !striped) return
  const light = new Color(ivory)
  const dark = new Color(ink)
  material.defines = { ...material.defines, ...(striped ? { CLOTH_STRIPES: '' } : {}), CLOTH_WEAVE: weave ? WEAVE_KIND[weave.kind] : 0 }
  material.onBeforeCompile = (shader) => {
    shader.uniforms.stripeIvory = { value: light }
    shader.uniforms.stripeInk = { value: dark }
    shader.uniforms.clothScale = { value: new Vector2(weave?.across ?? 1, weave?.down ?? 1) }
    shader.uniforms.clothDepth = { value: weave?.depth ?? 0 }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vClothAt;\n#ifdef CLOTH_STRIPES\nattribute float stripeAt;\nvarying float vStripeAt;\n#endif')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvClothAt = position;\n#ifdef CLOTH_STRIPES\nvStripeAt = stripeAt;\n#endif')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 stripeIvory;
        uniform vec3 stripeInk;
        uniform vec2 clothScale;
        uniform float clothDepth;
        varying vec3 vClothAt;
        #ifdef CLOTH_STRIPES
        varying float vStripeAt;
        #endif
        float clothHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float clothNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(clothHash(i), clothHash(i + vec2(1.0, 0.0)), u.x), mix(clothHash(i + vec2(0.0, 1.0)), clothHash(i + vec2(1.0, 1.0)), u.x), u.y);
        }
        // Where on the weave: round the body (its arc) and up it.
        vec2 clothPlace() {
          return vec2(atan(vClothAt.x, vClothAt.z) * length(vClothAt.xz), vClothAt.y) * clothScale;
        }
        // How far the weave stands out here, 0 to 1.
        float clothHeight(vec2 q) {
          #if CLOTH_WEAVE == 1
            // A stocking stitch: in each loop, a V of two legs leaning in.
            vec2 c = fract(q) - 0.5;
            vec2 l = mat2(0.88, -0.48, 0.48, 0.88) * vec2(c.x + 0.24, c.y);
            vec2 r = mat2(0.88, 0.48, -0.48, 0.88) * vec2(c.x - 0.24, c.y);
            float d = min(length(l / vec2(0.21, 0.52)), length(r / vec2(0.21, 0.52)));
            return clamp(1.0 - d * d, 0.0, 1.0);
          #elif CLOTH_WEAVE == 2
            return 0.5 + 0.5 * sin(6.2832 * (q.x + q.y));
          #elif CLOTH_WEAVE == 3
            return clothNoise(q) * 0.6 + clothNoise(q * 2.3 + 7.1) * 0.4;
          #else
            return 0.0;
          #endif
        }
        // Only where a loop or thread spans five pixels or more: finer, it drew as speckle.
        float clothFade(vec2 q) {
          vec2 w = fwidth(q);
          return 1.0 - smoothstep(0.12, 0.24, max(w.x, w.y));
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        #ifdef CLOTH_STRIPES
          // Ink from 0.62 to 1 of each stripe: how far from the ink's middle (0.81), against its half width.
          float edge = max(fwidth(vStripeAt), 1e-4);
          float fromInk = abs(fract(vStripeAt - 0.81 + 0.5) - 0.5);
          float inked = 1.0 - smoothstep(0.19 - edge, 0.19 + edge, fromInk);
          diffuseColor.rgb = mix(stripeIvory, stripeInk, inked);
        #endif
        #if CLOTH_WEAVE > 0
          vec2 clothQ = clothPlace();
          float clothH = clothHeight(clothQ);
          diffuseColor.rgb *= mix(1.0, mix(0.9, 1.03, clothH), clothFade(clothQ) * min(clothDepth, 1.0));
        #endif`)
  }
  material.customProgramCacheKey = () => `cloth-${striped ? 'striped-' : ''}${weave?.kind ?? 'plain'}`
}

/** Draw a striped piece's stripes (stripeHeights) and its knit (weaveCloth). */
export function knitStripes(material: MeshPhysicalMaterial, ivory = '#EEE8DE', ink = '#1D1C22') {
  weaveCloth(material, true, ivory, ink)
}

/**
 * The velvet parts a piece covers, whose pile (furCoat) is put away while it is worn: shoes and
 * gloves sit just over the feet and paws, and the pile poked through them in white specks. A
 * garment clears the pile only where it lies (coverPile).
 */
const COVERS: Record<string, readonly string[]> = {
  gloves: ['hand_l_mitten', 'hand_r_mitten'],
  ballet_flats: ['foot_l', 'foot_r'],
}

/** The velvet parts what `wear` holds covers (COVERS). */
export function coveredBy(wear: Iterable<string>): Set<string> {
  return new Set([...wear].flatMap((piece) => COVERS[piece] ?? []))
}

/** Show a velvet part's pile unless what it wears covers the part. */
export function showPile(figure: Object3D, covered: ReadonlySet<string>) {
  figure.traverse((object) => {
    if (object instanceof Mesh && (object.material as Material).name === 'pile' && object.parent) object.visible = !covered.has(object.parent.name)
  })
}

/** The pivots a garment's points follow besides the body, as its file names their pull (`_arm_l`…). */
const BENDS = ['arm_l', 'arm_r', 'hand_l', 'hand_r'] as const

/**
 * How much each point of `mesh` follows each of BENDS, or null for a mesh that doesn't bend. The
 * pipeline's garments carry it in their two texture coordinates, which the landing page's
 * compression keeps where it drops other attributes: uv (left arm, right arm), uv1 (left paw,
 * right paw), each v turned over by glTF (1 - v). A garment is marked by the pose it was made in
 * (`bind_arm_l`); `_arm_l`… attributes are read as they are.
 */
function pullsOf(mesh: Mesh): ((point: number) => number[]) | null {
  const geometry = mesh.geometry
  const named = BENDS.map((name) => geometry.getAttribute(`_${name}`))
  if (named[0]) return (point) => named.map((pull) => pull?.getX(point) ?? 0)
  const arm = geometry.getAttribute('uv')
  const paw = geometry.getAttribute('uv1')
  if (!Array.isArray(mesh.userData.bind_arm_l) || !arm || !paw) return null
  return (point) => [arm.getX(point), 1 - arm.getY(point), paw.getX(point), 1 - paw.getY(point)]
}

/**
 * Clothes that bend with the arms. A garment's file gives every point how much it follows each arm
 * and paw (pullsOf, from the figure pipeline); the rest follows the body. Each such mesh under `root` becomes a skinned mesh on the figure's own pivots, so a raised
 * arm carries its sleeve and stretches the shoulder with it, where a rigid sleeve swung away from the
 * coat. Call it on a figure at rest, once per copy: a copy made after (helper seats) needs
 * SkeletonUtils.clone, which gives the copy's clothes the copy's arms.
 */
export function bendClothes(root: Object3D): SkinnedMesh[] {
  const body = root.getObjectByName('body')
  const bends = BENDS.map((name) => root.getObjectByName(name))
  if (!body || bends.some((pivot) => !pivot)) return []
  const garments: Mesh[] = []
  root.traverse((object) => {
    if (object instanceof Mesh && !(object instanceof SkinnedMesh) && pullsOf(object)) garments.push(object)
  })
  if (garments.length === 0) return []
  // Each garment was made with the arms held as its file says (`bind_arm_l`, `bind_arm_r`: three's
  // Euler x, y, z): tie it to them held so, then put them back as they were.
  const [armL, armR] = bends as Object3D[]
  const held = [armL.rotation.clone(), armR.rotation.clone()]
  const bent = garments.map((mesh) => {
    const geometry = mesh.geometry
    if (!geometry.getAttribute('skinIndex')) {
      const pullAt = pullsOf(mesh)!
      const count = geometry.getAttribute('position').count
      const index = new Uint16Array(count * 4)
      const weight = new Float32Array(count * 4)
      for (let i = 0; i < count; i++) {
        const own = pullAt(i).map((pull) => Math.max(0, pull))
        const bodyShare = Math.max(0, 1 - own.reduce((sum, w) => sum + w, 0))
        // The four strongest pulls, the body's first (a point follows at most an arm and its paw).
        const ranked = [bodyShare, ...own].map((w, bone) => ({ w, bone })).sort((a, b) => b.w - a.w).slice(0, 4)
        const total = ranked.reduce((sum, { w }) => sum + w, 0) || 1
        ranked.forEach(({ w, bone }, k) => {
          index[i * 4 + k] = bone
          weight[i * 4 + k] = w / total
        })
      }
      geometry.setAttribute('skinIndex', new Uint16BufferAttribute(index, 4))
      geometry.setAttribute('skinWeight', new Float32BufferAttribute(weight, 4))
    }
    const skinned = new SkinnedMesh(geometry, mesh.material)
    skinned.name = mesh.name
    skinned.userData = { ...mesh.userData }
    skinned.visible = mesh.visible
    skinned.castShadow = mesh.castShadow
    skinned.receiveShadow = mesh.receiveShadow
    skinned.renderOrder = mesh.renderOrder
    skinned.position.copy(mesh.position)
    skinned.quaternion.copy(mesh.quaternion)
    skinned.scale.copy(mesh.scale)
    // Its bounds move with the arms: never culled for a stale one.
    skinned.frustumCulled = false
    const parent = mesh.parent
    if (parent) {
      parent.add(skinned)
      for (const child of [...mesh.children]) skinned.add(child)
      mesh.removeFromParent()
    }
    const made = mesh.userData
    if (Array.isArray(made.bind_arm_l) && Array.isArray(made.bind_arm_r)) {
      armL.rotation.set(...(made.bind_arm_l as [number, number, number]))
      armR.rotation.set(...(made.bind_arm_r as [number, number, number]))
    } else {
      armL.rotation.copy(held[0])
      armR.rotation.copy(held[1])
    }
    root.updateMatrixWorld(true)
    skinned.bind(new Skeleton([body, ...bends] as Bone[]), skinned.matrixWorld)
    return skinned
  })
  armL.rotation.copy(held[0])
  armR.rotation.copy(held[1])
  root.updateMatrixWorld(true)
  return bent
}

/**
 * Clear the pile where it would stand through the garment it wears, point by point, and nowhere else:
 * every point of a velvet part below the head (the body, the arms, the paws) whose way straight out
 * meets the cloth within its strands' reach (furCoat's length, and a little: COVER_MARGIN), with the
 * arms held as the garment was made for (`bind_arm_l`, `bind_arm_r`). The cloth lies close, as the
 * stills', and no pile shows through it; where none lies (the neck over the neckline, an arm past its
 * cuff) or it stands further off (over a wide build's arm held forward, where you see under it) the
 * pile grows. A height band, cleared from hem to neckline, left the neck bald by a raised arm and the
 * arm bald past its sleeve; cleared as far as a hand's width out, an arm under the shoulder's
 * overhang. `garment` is under `root`; null clears none.
 */
export function coverPile(root: Object3D, garment: Mesh | null) {
  const parts = pileParts(root).filter((part) => coverShown.get(part) !== garment)
  if (parts.length === 0) return
  const grid = garment ? clothGrid(garment.geometry) : null
  const toCloth = garment ? new Matrix4().copy(heldTo(root, garment, garment)).invert() : null
  for (const part of parts) {
    coverShown.set(part, garment)
    const cover = ownCover(part)
    if (!grid || !garment || !toCloth) {
      cover.array.fill(0)
    } else {
      let made = grid.made.get(part.geometry.getAttribute('position'))
      if (!made) {
        const length = typeof part.userData.pileLength === 'number' ? part.userData.pileLength : 0.03
        const comb = typeof part.userData.pileComb === 'number' ? part.userData.pileComb : 0
        made = coveredPoints(part.geometry, toCloth.clone().multiply(heldTo(root, part, garment)), grid, length, comb)
        grid.made.set(part.geometry.getAttribute('position'), made)
      }
      cover.array.set(made)
    }
    cover.needsUpdate = true
  }
}

/** How much further out than its strands reach the cloth clears a velvet point's pile, and how far in. */
const COVER_MARGIN = 0.006
const COVER_BELOW = 0.004
/** The cells the cloth's triangles are sorted into, a few of its own points across. */
const COVER_CELL = 0.03

/** The garment each velvet part's pile is cleared under now. */
const coverShown = new WeakMap<Mesh, Mesh | null>()
const pilePartsOf = new WeakMap<Object3D, Mesh[]>()

/**
 * The velvet parts under `root` that grow pile (furCoat), all but the head's. Found once for a
 * figure; found again when they are no longer under it (the bench shows another build in the same
 * node).
 */
function pileParts(root: Object3D): Mesh[] {
  const known = pilePartsOf.get(root)
  const under = (part: Object3D) => {
    let at: Object3D | null = part
    while (at && at !== root) at = at.parent
    return at === root
  }
  if (known && known.every(under)) return known
  const parts: Mesh[] = []
  root.traverse((object) => {
    if (!(object instanceof Mesh) || !object.children.some((child) => child instanceof Mesh && (child.material as Material).name === 'pile')) return
    for (let at: Object3D | null = object; at && at !== root; at = at.parent) if (at.name === 'head') return
    parts.push(object)
  })
  if (parts.length > 0) pilePartsOf.set(root, parts)
  return parts
}

/**
 * The cover a velvet part's pile reads (`pileCover`), its own: copies of a figure share their parts'
 * shapes, and each copy wears its own clothes. The copy shares every other attribute with the shape it
 * was made from, so nothing more is sent to the GPU.
 */
function ownCover(part: Mesh): BufferAttribute {
  const shared = part.geometry
  if (ownedCover.get(part) !== shared) {
    const own = new BufferGeometry()
    own.setIndex(shared.index)
    for (const [name, attribute] of Object.entries(shared.attributes)) if (name !== 'pileCover') own.setAttribute(name, attribute)
    own.setAttribute('pileCover', new BufferAttribute(new Float32Array(shared.getAttribute('position').count), 1))
    own.morphAttributes = shared.morphAttributes
    own.morphTargetsRelative = shared.morphTargetsRelative
    for (const group of shared.groups) own.addGroup(group.start, group.count, group.materialIndex)
    own.boundingBox = shared.boundingBox
    own.boundingSphere = shared.boundingSphere
    own.name = shared.name
    part.geometry = own
    for (const child of part.children) if (child instanceof Mesh && child.geometry === shared) child.geometry = own
    ownedCover.set(part, own)
  }
  return part.geometry.getAttribute('pileCover') as BufferAttribute
}
const ownedCover = new WeakMap<Mesh, BufferGeometry>()

/**
 * Where `node` is under `root`, with the arms held as `garment` was made (`bind_arm_l`,
 * `bind_arm_r`), whatever they hold now.
 */
function heldTo(root: Object3D, node: Object3D, garment: Mesh): Matrix4 {
  const held = new Map<Object3D, number[]>()
  for (const side of ['l', 'r']) {
    const arm = root.getObjectByName(`arm_${side}`)
    const bind = garment.userData[`bind_arm_${side}`]
    if (arm && Array.isArray(bind)) held.set(arm, bind as number[])
  }
  const matrix = new Matrix4()
  for (let at: Object3D | null = node; at && at !== root; at = at.parent) {
    const bind = held.get(at)
    if (bind) {
      matrix.premultiply(new Matrix4().compose(at.position, new Quaternion().setFromEuler(new Euler(bind[0], bind[1], bind[2], at.rotation.order)), at.scale))
    } else {
      at.updateMatrix()
      matrix.premultiply(at.matrix)
    }
  }
  return matrix
}

type ClothGrid = { position: BufferAttribute; corner: (triangle: number, k: number) => number; cells: Map<number, number[]>; triangles: number; made: WeakMap<object, Float32Array> }
const clothGrids = new WeakMap<BufferGeometry, ClothGrid>()
const cellKey = (x: number, y: number, z: number) => ((x + 1024) * 2048 + (y + 1024)) * 2048 + (z + 1024)

/** A garment's triangles sorted into cells (COVER_CELL), each a little wider, so a way out finds them. */
function clothGrid(geometry: BufferGeometry): ClothGrid {
  const known = clothGrids.get(geometry)
  if (known) return known
  const position = geometry.getAttribute('position') as BufferAttribute
  const index = geometry.index
  const corner = index ? (triangle: number, k: number) => index.getX(triangle * 3 + k) : (triangle: number, k: number) => triangle * 3 + k
  const triangles = Math.floor((index ? index.count : position.count) / 3)
  const cells = new Map<number, number[]>()
  // A step of the search is a third of a cell: a triangle within half a step of one is found.
  const margin = COVER_CELL / 6
  for (let t = 0; t < triangles; t++) {
    const low = [Infinity, Infinity, Infinity]
    const high = [-Infinity, -Infinity, -Infinity]
    for (let k = 0; k < 3; k++) {
      const i = corner(t, k)
      const at = [position.getX(i), position.getY(i), position.getZ(i)]
      for (let c = 0; c < 3; c++) {
        low[c] = Math.min(low[c], at[c])
        high[c] = Math.max(high[c], at[c])
      }
    }
    const from = low.map((v) => Math.floor((v - margin) / COVER_CELL))
    const to = high.map((v) => Math.floor((v + margin) / COVER_CELL))
    for (let x = from[0]; x <= to[0]; x++) for (let y = from[1]; y <= to[1]; y++) for (let z = from[2]; z <= to[2]; z++) {
      const key = cellKey(x, y, z)
      const list = cells.get(key)
      if (list) list.push(t)
      else cells.set(key, [t])
    }
  }
  const grid = { position, corner, cells, triangles, made: new WeakMap() }
  clothGrids.set(geometry, grid)
  return grid
}

/** 1 for each point of `shape` (placed in the cloth's space by `toCloth`) the cloth lies over, else 0. */
function coveredPoints(shape: BufferGeometry, toCloth: Matrix4, grid: ClothGrid, length: number, comb: number): Float32Array {
  const position = shape.getAttribute('position')
  const normal = shape.getAttribute('normal')
  const cover = new Float32Array(position.count)
  if (!normal) return cover
  const turn = new Matrix3().getNormalMatrix(toCloth)
  const along = new Matrix3().setFromMatrix4(toCloth)
  const at = new Vector3()
  const out = new Vector3()
  const lean = new Vector3()
  const way = new Vector3()
  const seen = new Uint32Array(grid.triangles)
  // Is there cloth along `way` from `at`, within `reach`? Each triangle is tried once a point.
  const clothAlong = (stamp: number, reach: number) => {
    for (let s = -COVER_BELOW; ; s = Math.min(reach, s + COVER_CELL / 3)) {
      const list = grid.cells.get(cellKey(Math.floor((at.x + way.x * s) / COVER_CELL), Math.floor((at.y + way.y * s) / COVER_CELL), Math.floor((at.z + way.z * s) / COVER_CELL)))
      for (const t of list ?? []) {
        if (seen[t] === stamp) continue
        seen[t] = stamp
        if (meets(grid, t, at, way, reach)) return true
      }
      if (s >= reach) return false
    }
  }
  for (let i = 0; i < position.count; i++) {
    at.fromBufferAttribute(position, i).applyMatrix4(toCloth)
    // Its strands: straight out at the roots, leaning down the surface toward their tips (combed, as
    // furCoat draws them), so both ways are tried, to the tip's reach.
    out.fromBufferAttribute(normal, i)
    lean.set(0, -1, 0).addScaledVector(out.normalize(), out.y)
    const tilt = lean.length()
    lean.multiplyScalar(tilt > 1e-4 ? (comb * Math.min(1, tilt * 4)) / tilt : 0).add(out)
    const tip = lean.length() * length
    lean.applyMatrix3(along).normalize()
    out.applyMatrix3(turn).normalize()
    way.copy(out)
    if (clothAlong(i * 2 + 1, length + COVER_MARGIN)) {
      cover[i] = 1
      continue
    }
    way.copy(lean)
    if (clothAlong(i * 2 + 2, tip + COVER_MARGIN)) cover[i] = 1
  }
  return cover
}

/**
 * Whether the way from `from` along `way` passes out through triangle `t` (the cloth's outside, as its
 * corners turn, faces along it) between COVER_BELOW in and `reach` out: a point under the cloth. A
 * paw in front of the cloth, whose way back meets the cloth's outside, keeps its pile: met either way,
 * a wide build's paws, held forward against its body, were bald where they showed.
 */
function meets(grid: ClothGrid, t: number, from: Vector3, way: Vector3, reach: number): boolean {
  const { position, corner } = grid
  const a = corner(t, 0)
  const b = corner(t, 1)
  const c = corner(t, 2)
  const ax = position.getX(a), ay = position.getY(a), az = position.getZ(a)
  const e1x = position.getX(b) - ax, e1y = position.getY(b) - ay, e1z = position.getZ(b) - az
  const e2x = position.getX(c) - ax, e2y = position.getY(c) - ay, e2z = position.getZ(c) - az
  const px = way.y * e2z - way.z * e2y, py = way.z * e2x - way.x * e2z, pz = way.x * e2y - way.y * e2x
  const det = e1x * px + e1y * py + e1z * pz
  // det is minus the way's share of the triangle's facing: below 0 the way goes out through it.
  if (det > -1e-12) return false
  const inv = 1 / det
  const tx = from.x - ax, ty = from.y - ay, tz = from.z - az
  const u = (tx * px + ty * py + tz * pz) * inv
  // A hair's give at the edges, so a way out along an edge between two triangles meets one of them.
  if (u < -1e-6 || u > 1 + 1e-6) return false
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x
  const v = (way.x * qx + way.y * qy + way.z * qz) * inv
  if (v < -1e-6 || u + v > 1 + 1e-6) return false
  const along = (e2x * qx + e2y * qy + e2z * qz) * inv
  return along >= -COVER_BELOW && along <= reach
}

/** Where a figure's arms are going: each arm's turn about x and about z (three's Euler), as a garment's `bind_arm_*` give them. */
export interface Arms {
  left: readonly [number, number]
  right: readonly [number, number]
}

/**
 * Nod a figure's head by `nod` (a turn about x: below 0 it tips back, looking up) and turn it by
 * `turn` (about y). Tipping back, it rocks on the front-most point of its own surface, so its front
 * outline stays where it was and its chin tucks into its body. Turned about its middle, the head
 * lifted its front off its body and showed the body's flat top under its chin, a pale shelf with a
 * rim. Nodding down it turns about its middle, which lifts only its back, out of sight.
 */
export function nodHead(head: Object3D, nod: number, turn: number) {
  const data = head.userData as { home?: Vector3; front?: Vector3 | null }
  data.home ??= head.position.clone()
  if (data.front === undefined) data.front = frontOfHead(head)
  head.rotation.set(nod, turn, 0)
  head.position.copy(data.home)
  if (nod >= 0 || !data.front) return
  // Where its front-most point would go, nodded about its middle, brought back.
  head.position.add(data.front).sub(data.front.clone().applyAxisAngle(X_AXIS, nod))
}

const X_AXIS = new Vector3(1, 0, 0)

/**
 * The front-most point of a head's own surface, in the head's space: its `head_mesh`, else its
 * largest mesh that isn't the sign on it; null with none.
 */
function frontOfHead(head: Object3D): Vector3 | null {
  let largest: Mesh | null = null
  for (const child of head.children) {
    if (!(child instanceof Mesh) || onSign(child) || !child.geometry.getAttribute('position')) continue
    if (child.name === 'head_mesh') { largest = child; break }
    if (!largest || child.geometry.getAttribute('position').count > largest.geometry.getAttribute('position').count) largest = child
  }
  if (!largest) return null
  const position = largest.geometry.getAttribute('position')
  const point = new Vector3()
  const front = new Vector3(0, 0, -Infinity)
  largest.updateMatrix()
  for (let i = 0; i < position.count; i += 1) {
    point.fromBufferAttribute(position, i).applyMatrix4(largest.matrix)
    if (point.z > front.z) front.copy(point)
  }
  return front.setX(0)
}

/** Whether `object` is part of the job's sign on a figure's head (`sign_<icon>`): smooth velvet, no pile. */
export function onSign(object: Object3D): boolean {
  for (let at: Object3D | null = object; at; at = at.parent) if (at.name.startsWith('sign_')) return true
  return false
}

/** A pose's arms, for poseClothes. */
export function armsOf(pose: { armLRX: number; armLRZ: number; armRRX: number; armRRZ: number }): Arms {
  return { left: [pose.armLRX, pose.armLRZ], right: [pose.armRRX, pose.armRRZ] }
}

/** How near its target the arms are (in radians, all four turns together) for a figure to have arrived (poseClothes). */
const ARRIVED = 0.06

/**
 * Show each worn garment as it was made for the pose nearest the arms. The figure pipeline makes a
 * garment once for each pose the bench and the landing page hold (`wear_<item>_pose_<pose>`, each
 * saying the arms it was made with, `bind_arm_l`, `bind_arm_r`), settled as cloth there, as the
 * stills' clothes are: one garment bent from a single pose twisted and flapped where a stubby arm
 * swung far. Each is bent a little with the arms (bendClothes), and the nearest is the one shown.
 * Call it each frame after the arms are set, with the figure's body (or any node holding its arms and
 * clothes). A garment marked not worn (`userData.worn === false`) stays hidden.
 *
 * With `toward`, where the arms are going, a figure on its way wears, bent to its arms, the garment
 * of the pose it left or the one it is going to, whichever was made with its arms further out
 * (furthest from the rest pose's), and the one it is going to once it is there. A paw raised to
 * wave and lowered again wears the clothes made with that paw up, all the way up and back down.
 * Shown the nearest on the way, an arm passed garments made for other poses (the paws at the
 * sides), each bent far from its own, and a garment with no sleeve for that arm dragged the cloth
 * at its shoulder out into a flap.
 */
export function poseClothes(root: Object3D, toward?: Arms) {
  const armL = root.getObjectByName('arm_l')
  const armR = root.getObjectByName('arm_r')
  if (!armL || !armR) return
  const now = [armL.rotation.x, armL.rotation.z, armR.rotation.x, armR.rotation.z]
  const goal = toward ? [toward.left[0], toward.left[1], toward.right[0], toward.right[1]] : now
  const arrived = Math.hypot(...now.map((turn, i) => turn - goal[i])) < ARRIVED
  const garments = new Map<string, Mesh[]>()
  root.traverse((object) => {
    if (!(object instanceof Mesh) || typeof object.userData.pose !== 'string' || !Array.isArray(object.userData.bind_arm_l)) return
    const item = object.name.replace(/_pose_[a-z]+$/, '')
    garments.set(item, [...(garments.get(item) ?? []), object])
  })
  for (const made of garments.values()) {
    const from = (arms: number[]) => (mesh: Mesh) => {
      const l = mesh.userData.bind_arm_l as number[]
      const r = mesh.userData.bind_arm_r as number[]
      return Math.hypot(arms[0] - l[0], arms[1] - l[2], arms[2] - r[0], arms[3] - r[2])
    }
    const nearest = (arms: number[]) => made.reduce((best, mesh) => (from(arms)(mesh) < from(arms)(best) ? mesh : best))
    const going = nearest(goal)
    let shown = going
    if (toward && !arrived) {
      // The one it wore when it set off, still shown.
      const left = made.find((mesh) => mesh.userData.shownForPose === true) ?? nearest(now)
      const rest = made.find((mesh) => mesh.userData.pose === 'rest')
      const out = (mesh: Mesh) => (rest ? from([rest.userData.bind_arm_l[0], rest.userData.bind_arm_l[2], rest.userData.bind_arm_r[0], rest.userData.bind_arm_r[2]])(mesh) : 0)
      shown = out(left) > out(going) ? left : going
    }
    for (const mesh of made) {
      mesh.userData.shownForPose = mesh === shown
      mesh.visible = mesh.userData.worn !== false && mesh === shown
    }
    // The pile clears under the one shown (coverPile).
    if (shown.visible) coverPile(root, shown)
  }
}

/** The mesh a worn garment shows at rest under `root`: its own, or the one made for the rest pose. */
export function garmentMesh(root: Object3D, garment: string): Mesh | null {
  const found = root.getObjectByName(`wear_${garment}`) ?? root.getObjectByName(`wear_${garment}_pose_rest`)
  return found instanceof Mesh ? found : null
}

/** Dress a wardrobe piece's mesh in its material (wearMaterial), its weave and its stripes drawn (weaveCloth). */
export function dressWear(mesh: Mesh): MeshPhysicalMaterial {
  const made = wearMaterial(mesh.material as Material)
  weaveCloth(made, !!mesh.geometry.getAttribute('stripeAt'))
  return made
}

/**
 * Drop the shadow maps of `scene`'s lights, so three makes them again on the next frame. The map it
 * makes on a scene's first frame stopped taking draws after it (in Chrome on a Mac nothing cleared it
 * or drew into it again), so that frame's shadows stayed for good: on the bench, those of the heads
 * and keys shown before it is dressed, banding the worn head. One made after that frame follows it.
 */
export function renewShadows(scene: Object3D) {
  scene.traverse((object) => {
    const shadow = object instanceof Light && object.castShadow ? (object as Light & { shadow?: LightShadow }).shadow : undefined
    if (!shadow?.map) return
    shadow.map.dispose()
    shadow.map = null
  })
}

/**
 * The room the figures are lit by (RoomEnvironment) as an environment map, its shaders compiled
 * first (readyToDraw): PMREMGenerator compiles the room's as it draws it, and waits for them. It
 * draws the room, and a backdrop behind it, into a picture, so theirs are compiled with one current.
 */
export async function roomEnvironment(renderer: WebGLRenderer, sigma: number): Promise<Texture> {
  const room = new RoomEnvironment()
  const backdrop = new Mesh(new BoxGeometry(), new MeshBasicMaterial({ side: BackSide }))
  const camera = new PerspectiveCamera(90, 1, 0.1, 100)
  const picture = new WebGLRenderTarget(1, 1, { type: HalfFloatType })
  const current = renderer.getRenderTarget()
  renderer.setRenderTarget(picture)
  const compiled = Promise.all([readyToDraw(renderer, room, camera), readyToDraw(renderer, backdrop, camera)])
  renderer.setRenderTarget(current)
  await compiled
  const pmrem = new PMREMGenerator(renderer)
  const map = pmrem.fromScene(room, sigma).texture
  // The backdrop's shader stays compiled while PMREMGenerator's own backdrop uses it.
  for (const item of [room, pmrem, picture, backdrop.geometry, backdrop.material]) item.dispose()
  return map
}

/**
 * Resolve once the GPU has drawn everything asked of it so far, checking now and then rather than
 * waiting on it (a WebGL2 fence). A first frame leaves the GPU busy for a while after it is sent,
 * making the shaders' pipelines; anything that asks the GPU a question meanwhile, as making another
 * WebGL context does, waits for all of it.
 */
export function drawn(renderer: WebGLRenderer): Promise<void> {
  const gl = renderer.getContext()
  if (!(gl instanceof WebGL2RenderingContext)) return Promise.resolve()
  const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
  if (!fence) return Promise.resolve()
  gl.flush()
  return new Promise((resolve) => {
    const check = () => {
      if (gl.isContextLost() || gl.getSyncParameter(fence, gl.SYNC_STATUS) === gl.SIGNALED) {
        gl.deleteSync(fence)
        resolve()
      } else setTimeout(check, 16)
    }
    setTimeout(check, 16)
  })
}

/** What WebGLRenderer keeps for a material it has compiled (its `properties`). */
interface Compiled {
  currentProgram?: { isReady: () => boolean; getUniforms: () => unknown }
}

/**
 * The look of each material in workbench.glb, by the role Blender named it. The figure's skin is
 * coloured when it is dressed. Shared with the landing page's crew (src/site/crewScene.ts), so a
 * figure looks the same there as on its bench.
 */
export function benchMaterial(role: string, mesh: string, textures: { pegboard: () => Texture; wound: Texture | null }): Material {
  const physical = (color: string, roughness: number, clearcoat = 0.4) => new MeshPhysicalMaterial({ color, roughness, clearcoat, clearcoatRoughness: 0.35 })
  const standard = (color: string, roughness: number, metalness = 0) => new MeshStandardMaterial({ color, roughness, metalness })
  const soft = (color: string) => new MeshPhysicalMaterial({ color, roughness: 0.62, specularIntensity: 0.7, sheen: 0.35, sheenRoughness: 0.6, sheenColor: '#FFFFFF' })
  const pile = (color: string) => { const skin = new MeshPhysicalMaterial({ roughness: 0.9, specularIntensity: 0.7, sheen: 1, sheenRoughness: 0.6, envMapIntensity: VELVET_FILL }); paintSkin(skin, new Color(color)); return skin }
  switch (role) {
    case 'bone': return physical('#EFEAE0', 0.5, 0.55)
    case 'benchtop': return physical('#E6DFD1', 0.6, 0.3)
    case 'graphite': return physical('#24242B', 0.55, 0.35)
    case 'shoe': return physical('#2B2B33', 0.55, 0.3)
    case 'pegboard': return mesh === 'pegboard_face' ? new MeshStandardMaterial({ map: textures.pegboard(), roughness: 0.9 }) : standard('#1C1C21', 0.8)
    // The figure, soft to the touch under a short flocked pile, as in its stills: matte, no clear coat,
    // a velvet sheen. Its skin is coloured when it is dressed (wear), in velvetColor.
    case 'skin': return pile('#E3A386')
    case 'skin_wound': return Object.assign(pile('#E3A386'), { bumpMap: textures.wound, bumpScale: 1.6 })
    case 'skin_deep': return pile('#C38C73')
    case 'blush': return new MeshStandardMaterial({ color: '#F08A8A', roughness: 0.9, transparent: true, opacity: 0.55, depthWrite: false })
    case 'eye': return new MeshPhysicalMaterial({ color: '#1E1E26', roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.08 })
    // The velvet figure's face (public/agent/figure/<build>.glb): soft brows, a glossy nose, a thin
    // smile and three gold freckles a cheek.
    case 'brow': return standard('#4E4656', 0.8)
    case 'nose': return new MeshPhysicalMaterial({ color: '#3A2F38', roughness: 0.35, clearcoat: 0.6, clearcoatRoughness: 0.2 })
    case 'mouth': return standard('#2E2830', 0.7)
    case 'freckle': return standard('#C99A4A', 0.6)
    case 'glint': return new MeshBasicMaterial({ color: '#FFFFFF' })
    case 'stitch': return standard('#D8A93C', 0.35, 0.6)
    case 'wood': return soft('#E9D5B1')
    case 'leaf': return soft('#6E9C6A')
    case 'steel': return standard('#C9CCD2', 0.3, 0.9)
    case 'pin_a': return physical('#E9C46A', 0.3, 0.6)
    case 'pin_b': return physical('#F4F1EA', 0.3, 0.6)
    case 'pin_c': return physical('#4A4A55', 0.3, 0.6)
    case 'gold': return standard('#E2B451', 0.3, 1)
    case 'appband': return new MeshStandardMaterial({ color: '#85817A', emissive: LIVE, emissiveIntensity: 0, roughness: 0.4 })
    case 'screen': return new MeshStandardMaterial({ color: '#141A24', emissive: LIVE, emissiveIntensity: 0.12, roughness: 0.3 })
    // The worded faces are left plain: AgentFigure lays their words over them as page text.
    case 'paper': return standard(mesh === 'laptop_face' ? '#2B2B33' : mesh === 'nameplate_face' ? '#EFEAE0' : '#F4EFE4', 0.85)
    case 'ink': return standard('#B9B1A2', 0.85)
    case 'tag_web': return standard('#E9C46A', 0.5)
    case 'tag_files': return standard('#EFEAE0', 0.55)
    case 'tag_cmd': return standard('#3A3A44', 0.55)
    default: return standard('#888888', 0.6)
  }
}
