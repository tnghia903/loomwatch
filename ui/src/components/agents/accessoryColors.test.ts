import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Read from disk: a `?raw` import is empty under vitest, which would make this pass on nothing.
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

/** CIE L*a*b* of an sRGB hex colour, D65. */
function lab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const [x, y, z] = [(r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047, r * 0.2126 + g * 0.7152 + b * 0.0722, (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883].map(f)
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
}

/** CIEDE2000: how far apart two colours look. */
function distance(one: string, two: string): number {
  const [[l1, a1, b1], [l2, a2, b2]] = [lab(one), lab(two)]
  const rad = Math.PI / 180
  const mean = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2
  const g = 0.5 * (1 - Math.sqrt(mean ** 7 / (mean ** 7 + 25 ** 7)))
  const [p1, p2] = [(1 + g) * a1, (1 + g) * a2]
  const [c1, c2] = [Math.hypot(p1, b1), Math.hypot(p2, b2)]
  const [h1, h2] = [(Math.atan2(b1, p1) / rad + 360) % 360, (Math.atan2(b2, p2) / rad + 360) % 360]
  let dh = c1 * c2 === 0 ? 0 : h2 - h1
  if (dh > 180) dh -= 360
  else if (dh < -180) dh += 360
  const dH = 2 * Math.sqrt(c1 * c2) * Math.sin((dh / 2) * rad)
  const [l, c] = [(l1 + l2) / 2, (c1 + c2) / 2]
  const h = c1 * c2 === 0 ? h1 + h2 : Math.abs(h1 - h2) <= 180 ? (h1 + h2) / 2 : (h1 + h2 + 360) / 2
  const t = 1 - 0.17 * Math.cos((h - 30) * rad) + 0.24 * Math.cos(2 * h * rad) + 0.32 * Math.cos((3 * h + 6) * rad) - 0.2 * Math.cos((4 * h - 63) * rad)
  const sl = 1 + (0.015 * (l - 50) ** 2) / Math.sqrt(20 + (l - 50) ** 2)
  const [sc, sh] = [1 + 0.045 * c, 1 + 0.015 * c * t]
  const rt = -Math.sin(2 * 30 * Math.exp(-(((h - 275) / 25) ** 2)) * rad) * 2 * Math.sqrt(c ** 7 / (c ** 7 + 25 ** 7))
  return Math.sqrt(((l2 - l1) / sl) ** 2 + ((c2 - c1) / sc) ** 2 + (dH / sh) ** 2 + rt * ((c2 - c1) / sc) * (dH / sh))
}

describe('what a figure wears', () => {
  it('never uses a status colour: blue runs, gold is you, red is trouble (lib/library/figures.ts)', () => {
    // The palette's blues, golds (brass is the dim gold) and reds; their tints are backgrounds.
    const status = [...read('src/styles/tokens.css').matchAll(/--lw-(?:gold|brass|blue|red)-\d+:\s*(#[0-9a-f]{6})/gi)].map((match) => match[1])
    const worn = [...new Set([...read('src/components/agents/accessoryMeshes.ts').matchAll(/['"](#[0-9a-f]{6})['"]/gi)].map((match) => match[1].toUpperCase()))]
    expect(status.length).toBeGreaterThanOrEqual(10)
    expect(worn.length).toBeGreaterThanOrEqual(10)
    // 10 is where two colours stop reading as one; the nearest worn now is the shuttle's wood, at 11.5.
    const close = worn.flatMap((colour) => status.filter((token) => distance(colour, token) < 10).map((token) => `${colour} is ${distance(colour, token).toFixed(1)} from ${token}`))
    expect(close).toEqual([])
  })

  it('measures how alike two colours look', () => {
    expect(distance('#E9C46A', '#E9C46A')).toBe(0)
    // The colours the wardrobe first shipped with: a thread in the error red, a pin in your gold.
    expect(distance('#B4473F', '#C0342E')).toBeLessThan(10)
    expect(distance('#C9A24A', '#D8A93C')).toBeLessThan(10)
    expect(distance('#7B3F73', '#C0342E')).toBeGreaterThan(20)
  })
})
