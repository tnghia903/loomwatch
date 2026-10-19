import { CanvasTexture, RepeatWrapping, SRGBColorSpace, type Texture } from 'three'

/**
 * Pictures drawn on the workbench at run time: the thread wound on the figure's head, the words on
 * its key tags and the recipe cards. They are canvases, so they always show the real
 * setting. The scene keeps its own colours in both themes, like a photograph of a real bench, and
 * draws in the app's own fonts. The words meant to be read (the nameplate, the job sheet, the
 * laptop's lid) are not painted: painted words blur once the bench is drawn small, so AgentFigure
 * lays them over their faces as page text.
 */

const BONE = '#EFEAE0'
const INK = '#17150F'

function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const element = document.createElement('canvas')
  element.width = width
  element.height = height
  const context = element.getContext('2d')
  if (!context) throw new Error('This browser cannot draw on a canvas.')
  return [element, context]
}

/** A canvas as a texture that sits on the model's own UVs (glTF UVs start at the top). */
function texture(element: HTMLCanvasElement, color = true): Texture {
  const made = new CanvasTexture(element)
  made.flipY = false
  if (color) made.colorSpace = SRGBColorSpace
  made.anisotropy = 4
  return made
}

export function fonts() {
  const style = getComputedStyle(document.documentElement)
  return {
    sans: style.getPropertyValue('--font-sans').trim() || 'Inter, system-ui, sans-serif',
    serif: style.getPropertyValue('--font-serif').trim() || 'Georgia, serif',
  }
}

/** Write `text` on one line no wider than `width`, shrinking it down to `min` and then cutting it. */
function fitLine(context: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, size: number, min: number, face: (size: number) => string) {
  let current = size
  context.font = face(current)
  while (context.measureText(text).width > width && current > min) {
    current -= 2
    context.font = face(current)
  }
  let line = text
  while (line.length > 1 && context.measureText(line).width > width) line = line.slice(0, -1)
  context.fillText(line === text ? text : `${line.slice(0, -1)}…`, x, y)
}

/** Lines of `text` wrapped to `width`, at most `max` of them. */
function wrap(context: CanvasRenderingContext2D, text: string, width: number, max: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split(/\n+/)) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word
      if (context.measureText(next).width > width && line) {
        lines.push(line)
        line = word
        if (lines.length >= max) return lines
      } else line = next
    }
    if (line) lines.push(line)
    if (lines.length >= max) return lines
  }
  return lines
}

/** The pegboard: obsidian with the canvas's dot grid, and one gold thread across it. */
export function pegboardTexture(): Texture {
  const [element, context] = canvas(2048, 904)
  context.fillStyle = '#16161B'
  context.fillRect(0, 0, element.width, element.height)
  context.fillStyle = '#2C2C34'
  const step = 44
  for (let y = step / 2; y < element.height; y += step) {
    for (let x = step / 2; x < element.width; x += step) {
      context.beginPath()
      context.arc(x, y, 4.2, 0, Math.PI * 2)
      context.fill()
    }
  }
  context.strokeStyle = 'rgba(216, 169, 60, 0.55)'
  context.lineWidth = 4
  context.beginPath()
  context.moveTo(-20, 760)
  context.bezierCurveTo(520, 640, 760, 840, 1024, 760)
  context.bezierCurveTo(1290, 680, 1560, 860, 2070, 720)
  context.stroke()
  return texture(element)
}

/** A key's word on its tag. */
export function keyLabelTexture(word: string, dark: boolean): Texture {
  const [element, context] = canvas(256, 116)
  const { sans } = fonts()
  context.fillStyle = dark ? '#3A3A44' : word === 'Web' ? '#E9C46A' : BONE
  context.fillRect(0, 0, element.width, element.height)
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillStyle = dark ? BONE : INK
  fitLine(context, word, 128, 60, 230, 54, 26, (size) => `700 ${size}px ${sans}`)
  return texture(element)
}

/** One recipe card on the pegboard: a skill, by its name. */
export function cardTexture(skill: string, index: number): Texture {
  const [element, context] = canvas(320, 240)
  const { sans } = fonts()
  context.fillStyle = BONE
  context.fillRect(0, 0, element.width, element.height)
  context.fillStyle = ['#E9C46A', '#D9D2C4', '#85817A'][index % 3]
  context.beginPath()
  context.roundRect(24, 26, 86, 16, 8)
  context.fill()
  context.fillStyle = INK
  context.font = `700 50px ${sans}`
  context.textBaseline = 'top'
  wrap(context, skill.replace(/[-_]+/g, ' '), 280, 3).forEach((line, row) => context.fillText(line, 22, 58 + row * 56))
  return texture(element)
}

/**
 * A tool's tile in the tool drawer, as ToolIcon draws it in the app: its own icon on white, or its
 * first letter when it has none or the icon won't load. LoomWatch serves the icon from its own
 * address (`icons.rs`), so the canvas stays clean enough to draw on the bench. The tile is blank
 * white until the icon arrives. Drawn on the shape's own UVs, which start at the bottom.
 */
export function toolTexture(name: string, icon: string | null): Texture {
  const size = 256
  const [element, context] = canvas(size, size)
  const made = texture(element)
  made.flipY = true
  const tile = (fill: string) => {
    context.clearRect(0, 0, size, size)
    context.fillStyle = fill
    context.fillRect(0, 0, size, size)
    // ToolIcon's hairline, just inside the tile's edge.
    context.strokeStyle = 'rgba(0, 0, 0, 0.08)'
    context.lineWidth = 6
    context.beginPath()
    context.roundRect(3, 3, size - 6, size - 6, size * 0.24)
    context.stroke()
  }
  const letter = () => {
    tile('#F4EAD0')
    context.fillStyle = '#8A6A1E'
    context.font = `600 ${Math.round(size * 0.46)}px ${fonts().sans}`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(name.trim().charAt(0).toUpperCase() || '?', size / 2, size * 0.53)
    made.needsUpdate = true
  }
  if (!icon) { letter(); return made }
  tile('#FFFFFF')
  const image = new Image()
  image.decoding = 'async'
  image.onload = () => {
    if (!image.naturalWidth) { letter(); return }
    // Contained, inside ToolIcon's padding.
    const room = size * 0.78
    const scale = Math.min(room / image.naturalWidth, room / image.naturalHeight)
    const [width, height] = [image.naturalWidth * scale, image.naturalHeight * scale]
    context.imageSmoothingQuality = 'high'
    context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height)
    made.needsUpdate = true
  }
  image.onerror = letter
  image.src = icon
  return made
}

/** Cross-wound thread, as a bump map, for the heads that are wound (the yarn ball, the spool, the cone). */
export function woundTexture(): Texture {
  const size = 256
  const [element, context] = canvas(size, size)
  context.fillStyle = '#000'
  context.fillRect(0, 0, size, size)
  context.lineCap = 'round'
  // Two layers of strands crossing on the diagonal, the top layer a little higher.
  for (const [slope, alpha] of [[1, 0.9], [-1, 0.7]] as const) {
    // A period that divides the tile, so it repeats without a seam.
    for (let step = -size; step < size * 2; step += 8) {
      context.strokeStyle = `rgba(255, 255, 255, ${alpha})`
      context.lineWidth = 4
      context.beginPath()
      context.moveTo(step, 0)
      context.lineTo(step + slope * size, size)
      context.stroke()
    }
  }
  const made = texture(element, false)
  made.wrapS = RepeatWrapping
  made.wrapT = RepeatWrapping
  return made
}

/** A soft round glow, white in the middle and fading to nothing at the edge: the bulb's halo. */
export function glowTexture(): Texture {
  const [element, context] = canvas(64, 64)
  const fade = context.createRadialGradient(32, 32, 0, 32, 32, 32)
  fade.addColorStop(0, 'rgba(255,255,255,1)')
  fade.addColorStop(0.35, 'rgba(255,255,255,0.45)')
  fade.addColorStop(1, 'rgba(255,255,255,0)')
  context.fillStyle = fade
  context.fillRect(0, 0, 64, 64)
  return texture(element)
}
