import {
  Color,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  ShaderMaterial,
  SRGBColorSpace,
  Vector2,
  Vector4,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three'

import { readyToDraw } from '../components/agents/workbenchModel'

/** Taps each side of the centre in one blur pass. */
const TAPS = 8

const FLAT_VERTEX = /* glsl */ `
void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`
const FLAT_FRAGMENT = /* glsl */ `
uniform vec4 tint;
void main() { gl_FragColor = tint; }`

const QUAD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`
const BLUR_FRAGMENT = /* glsl */ `
uniform sampler2D map;
uniform vec2 stride;
uniform float weights[${TAPS + 1}];
varying vec2 vUv;
void main() {
  vec4 sum = texture2D(map, vUv) * weights[0];
  for (int i = 1; i <= ${TAPS}; i++) {
    vec2 off = stride * float(i);
    sum += (texture2D(map, vUv + off) + texture2D(map, vUv - off)) * weights[i];
  }
  gl_FragColor = sum;
}`
// The blur holds each figure's colour times how strongly it glows; laid down, a glow is brightest
// at the figure's edge and fades out from it, as a CSS drop-shadow does.
const LAY_FRAGMENT = /* glsl */ `
uniform sampler2D map;
uniform float opacity;
varying vec2 vUv;
void main() {
  vec4 blur = texture2D(map, vUv);
  if (blur.a < 0.002) discard;
  float a = opacity * (1.0 - exp(-3.2 * blur.a));
  gl_FragColor = vec4(blur.rgb / blur.a * a, a);
}`

/**
 * A glow round each figure's outline in the colour of what it is doing, the way an agent's figure
 * glows in the app (a CSS drop-shadow there). Each frame the figures are drawn flat, each in its
 * own colour, into a picture half the canvas's size; that is blurred, and the blur is laid on the
 * cleared canvas. The scene is then drawn over it, so the glow shows only round each figure.
 */
export class CrewGlow {
  private readonly renderer: WebGLRenderer
  private readonly flat: WebGLRenderTarget
  private readonly ping: WebGLRenderTarget
  private readonly pong: WebGLRenderTarget
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly quad: Mesh<PlaneGeometry, ShaderMaterial>
  private readonly blur: ShaderMaterial
  private readonly lay: ShaderMaterial
  private readonly tints: ShaderMaterial[] = []
  /** How far apart the blur's taps are, in the flat picture's pixels. */
  private step = 1

  constructor(renderer: WebGLRenderer, opacity: number) {
    this.renderer = renderer
    this.flat = new WebGLRenderTarget(1, 1)
    this.ping = new WebGLRenderTarget(1, 1, { depthBuffer: false })
    this.pong = new WebGLRenderTarget(1, 1, { depthBuffer: false })
    this.blur = new ShaderMaterial({
      uniforms: { map: { value: null }, stride: { value: new Vector2() }, weights: { value: new Array<number>(TAPS + 1).fill(0) } },
      vertexShader: QUAD_VERTEX, fragmentShader: BLUR_FRAGMENT, depthTest: false, depthWrite: false,
    })
    this.lay = new ShaderMaterial({
      uniforms: { map: { value: this.pong.texture }, opacity: { value: opacity } },
      vertexShader: QUAD_VERTEX, fragmentShader: LAY_FRAGMENT, depthTest: false, depthWrite: false, transparent: true, premultipliedAlpha: true,
    })
    this.quad = new Mesh(new PlaneGeometry(2, 2), this.blur)
    this.quad.frustumCulled = false
  }

  /** A flat material to draw one figure into the glow with; its colour is set by tint(). */
  material(): ShaderMaterial {
    const material = new ShaderMaterial({ uniforms: { tint: { value: new Vector4() } }, vertexShader: FLAT_VERTEX, fragmentShader: FLAT_FRAGMENT })
    this.tints.push(material)
    return material
  }

  /** The canvas's size, and how far the glow spreads (the blur's sigma), all in device pixels. */
  resize(across: number, down: number, spread: number) {
    const width = Math.max(1, Math.round(across / 2))
    const height = Math.max(1, Math.round(down / 2))
    for (const target of [this.flat, this.ping, this.pong]) target.setSize(width, height)
    // A Gaussian, in the half-size picture's pixels, its taps reaching out 2.5 sigmas.
    const sigma = Math.max(0.5, spread / 2)
    this.step = (2.5 * sigma) / TAPS
    const weights = this.blur.uniforms.weights.value as number[]
    for (let i = 0; i <= TAPS; i += 1) weights[i] = Math.exp(-((i * this.step) ** 2) / (2 * sigma * sigma))
    const sum = weights[0] + 2 * weights.slice(1).reduce((a, b) => a + b, 0)
    for (let i = 0; i <= TAPS; i += 1) weights[i] /= sum
  }

  /**
   * Clear the canvas and lay the glow on it. `drawFlat` draws the figures, each in its own flat
   * material and nothing else, into whatever target is current.
   */
  draw(drawFlat: () => void) {
    const renderer = this.renderer
    renderer.setRenderTarget(this.flat)
    renderer.clear()
    drawFlat()
    const step = this.step
    const pass = (from: WebGLRenderTarget, to: WebGLRenderTarget, x: number, y: number) => {
      this.blur.uniforms.map.value = from.texture
      ;(this.blur.uniforms.stride.value as Vector2).set((x * step) / from.width, (y * step) / from.height)
      this.quad.material = this.blur
      renderer.setRenderTarget(to)
      renderer.render(this.quad, this.camera)
    }
    pass(this.flat, this.ping, 1, 0)
    pass(this.ping, this.pong, 0, 1)
    renderer.setRenderTarget(null)
    renderer.clear()
    this.quad.material = this.lay
    renderer.render(this.quad, this.camera)
  }

  /**
   * Compile the glow's shaders before its first frame, as readyToDraw (workbenchModel.ts) does the
   * scene's. `compileFlat` compiles the figures as `drawFlat` draws them. A shader is compiled for
   * where it draws, a picture or the canvas, so each is compiled with that target current.
   */
  compile(compileFlat: () => Promise<unknown>): Promise<unknown> {
    const renderer = this.renderer
    renderer.setRenderTarget(this.flat)
    const flat = compileFlat()
    renderer.setRenderTarget(this.ping)
    this.quad.material = this.blur
    const blur = readyToDraw(renderer, this.quad, this.camera)
    renderer.setRenderTarget(null)
    const lay = readyToDraw(renderer, new Mesh(this.quad.geometry, this.lay), this.camera)
    return Promise.all([flat, blur, lay])
  }

  dispose() {
    for (const target of [this.flat, this.ping, this.pong]) target.dispose()
    for (const material of [this.blur, this.lay, ...this.tints]) material.dispose()
    this.quad.geometry.dispose()
  }
}

/**
 * A CSS colour as the glow's colour: its sRGB channels as they are, since the glow is drawn without
 * colour management, straight onto the page.
 */
export function glowColor(css: string): Vector4 {
  const rgb = new Color(css).getRGB({ r: 0, g: 0, b: 0 }, SRGBColorSpace)
  return new Vector4(rgb.r, rgb.g, rgb.b, 1)
}

/** Ease a figure's tint toward `color` glowing at `strength` (0 to 1), premultiplied. */
export function easeTint(tint: Vector4, color: Vector4, strength: number, ease: number) {
  tint.x += (color.x * strength - tint.x) * ease
  tint.y += (color.y * strength - tint.y) * ease
  tint.z += (color.z * strength - tint.z) * ease
  tint.w += (strength - tint.w) * ease
}
