import { HalfFloatType, Mesh, Vector2, WebGLRenderTarget, type Camera, type Object3D, type Scene, type WebGLRenderer } from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'

/**
 * How far round a point the bench looks for what crowds it, in the scene's units (a figure stands
 * about 0.75 tall), and how strongly it darkens it.
 */
export const SHADING = { radius: 0.14, strength: 0.85 }

/**
 * The bench drawn with soft shade where things crowd each other (ambient occlusion: under a figure's
 * head, round its arms and paws, in its clothes' folds, under the laptop), as its stills are lit: lit
 * evenly all over, the figure read flat. Drawn into a multisampled target, so edges stay smooth, and
 * through to the canvas with the renderer's own tone and colour space; where nothing is drawn the
 * canvas stays clear. Only what `shades` keeps (the figures) is shaded and shades: from the whole
 * room, the wall round a figure's head darkened too, and its fur's soft outline took that up as a
 * dark rim.
 */
export class SoftShading {
  private readonly composer: EffectComposer
  private readonly occlusion: GTAOPass

  constructor(renderer: WebGLRenderer, scene: Scene, camera: Camera, shades: (mesh: Mesh) => boolean) {
    const size = renderer.getDrawingBufferSize(new Vector2())
    this.composer = new EffectComposer(renderer, new WebGLRenderTarget(size.x, size.y, { type: HalfFloatType, samples: 4 }))
    // The canvas is sized in device pixels already (fitCanvas).
    this.composer.setPixelRatio(1)
    this.composer.addPass(new RenderPass(scene, camera))
    this.occlusion = new GTAOPass(scene, camera, size.x, size.y)
    this.occlusion.updateGtaoMaterial({ radius: SHADING.radius, distanceExponent: 1.4, thickness: 1, scale: 1, samples: 16, distanceFallOff: 1 })
    this.occlusion.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, rings: 2, samples: 16 })
    this.occlusion.blendIntensity = SHADING.strength
    // Its depth and facing are drawn with what it doesn't shade hidden, put back after (three's own
    // visibility cache, which it empties when it puts them back).
    const pass = this.occlusion as unknown as { _overrideVisibility(): void; _visibilityCache: Object3D[] }
    const hide = pass._overrideVisibility.bind(pass)
    pass._overrideVisibility = () => {
      hide()
      pass._visibilityCache.push(...hideUnshaded(scene, shades))
    }
    this.composer.addPass(this.occlusion)
    this.composer.addPass(new OutputPass())
    this.composer.setSize(size.x, size.y)
  }

  render() {
    this.composer.render()
  }

  /** The canvas's new size, in device pixels. */
  setSize(width: number, height: number) {
    this.composer.setSize(width, height)
  }

  dispose() {
    this.occlusion.dispose()
    this.composer.dispose()
  }
}

/** Hide every shown mesh in `scene` that `shades` doesn't keep; returns them, to be shown again. */
export function hideUnshaded(scene: Scene, shades: (mesh: Mesh) => boolean): Object3D[] {
  const hidden: Object3D[] = []
  scene.traverse((object) => {
    if (object instanceof Mesh && object.visible && !shades(object)) {
      object.visible = false
      hidden.push(object)
    }
  })
  return hidden
}
