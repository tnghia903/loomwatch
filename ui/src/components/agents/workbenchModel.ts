import {
  BackSide,
  BoxGeometry,
  Color,
  HalfFloatType,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PMREMGenerator,
  Texture,
  WebGLRenderTarget,
  type Camera,
  type Material,
  type Object3D,
  type Scene,
  type WebGLRenderer,
} from 'three'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

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
 */
export function fitCanvas(renderer: WebGLRenderer, width: number, height: number): { width: number; height: number } {
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
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
  switch (role) {
    case 'bone': return physical('#EFEAE0', 0.5, 0.55)
    case 'benchtop': return physical('#E6DFD1', 0.6, 0.3)
    case 'graphite': return physical('#24242B', 0.55, 0.35)
    case 'shoe': return physical('#2B2B33', 0.55, 0.3)
    case 'pegboard': return mesh === 'pegboard_face' ? new MeshStandardMaterial({ map: textures.pegboard(), roughness: 0.9 }) : standard('#1C1C21', 0.8)
    // The figure, soft to the touch as in its stills: matte, no clear coat, a little sheen. Its skin is
    // coloured when it is dressed (wear), from the figure it wears.
    case 'skin': return soft('#E3A386')
    case 'skin_wound': return Object.assign(soft('#E3A386'), { bumpMap: textures.wound, bumpScale: 1.6 })
    case 'skin_deep': return soft('#C38C73')
    case 'blush': return new MeshStandardMaterial({ color: '#F08A8A', roughness: 0.9, transparent: true, opacity: 0.55, depthWrite: false })
    case 'eye': return new MeshPhysicalMaterial({ color: '#1E1E26', roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.08 })
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
