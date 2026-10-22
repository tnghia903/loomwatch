import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { appRules, cascaded, DESKTOP, type Rule } from './cascade'

// What a colour token is in each theme, and how well words in one read on another: by WCAG 2's ratio,
// and by APCA's lightness contrast (Lc), which catches the red or brass that passes 4.5:1 yet reads
// muddy. Read from tokens.css on disk, so a test measures the colours the app ships.

export type Theme = 'light' | 'dark'
export const THEMES: Theme[] = ['light', 'dark']

const DARK = '[data-theme="dark"]'
const tokens = (() => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const light = new Map<string, string>()
  const dark = new Map<string, string>()
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const into = selector.trim() === DARK ? dark : light
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) into.set(name, value.trim())
  }
  // Dark sets only what differs; everything else is the light theme's, as in the browser.
  return { light, dark: new Map([...light, ...dark]) }
})()

// The app's rules that set each custom property, so a lookup reads those few, not every rule.
const setting = new Map<string, Rule[]>()
for (const rule of appRules) {
  for (const name of new Set([...rule.body.matchAll(/(?:^|;)\s*(--[\w-]+)\s*:/g)].map(([, found]) => found))) setting.set(name, [...setting.get(name) ?? [], rule])
}

/**
 * The colour a value such as `var(--color-alert)` is in a theme, as `#RRGGBB`. Throws on a mix or a
 * wash. Given an element, a property is what the cascade sets on it or the nearest ancestor that sets
 * it, as the browser inherits it: the dark shell sets its own panel and ink. Else tokens.css's. A
 * property set to another is read where it was set, as the browser computes it there.
 */
export function tokenColour(value: string | null, theme: Theme, on?: Element): string {
  const root = on?.ownerDocument.documentElement ?? null
  const was = root?.getAttribute('data-theme')
  root?.setAttribute('data-theme', theme)
  try {
    let at = value ?? ''
    let from = on ?? null
    for (let step = 0; step < 8; step += 1) {
      if (/^#[\da-f]{6}$/i.test(at)) return at.toUpperCase()
      const name = /^var\((--[\w-]+)\)$/.exec(at)?.[1]
      if (!name) break
      let set: string | null = null
      const rules = setting.get(name) ?? []
      while (from && (set = rules.length ? cascaded(from, name, DESKTOP, rules) : null) === null) from = from.parentElement
      if (set === null) {
        if (!tokens[theme].has(name)) break
        set = tokens[theme].get(name)!
        from = root
      }
      at = set
    }
    throw new Error(`${value} is not one solid colour in the ${theme} theme`)
  } finally {
    if (was === null || was === undefined) root?.removeAttribute('data-theme')
    else root?.setAttribute('data-theme', was)
  }
}

const channels = (hex: string) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255)

/** WCAG 2's contrast ratio between two colours, 1 to 21. */
export function wcagRatio(one: string, other: string): number {
  const luminance = (hex: string) => {
    const [r, g, b] = channels(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [light, dark] = [luminance(one), luminance(other)].sort((a, b) => b - a)
  return (light + 0.05) / (dark + 0.05)
}

/** APCA's lightness contrast of text on a background (0.0.98G-4g): about 0 to 106, negative for light text on dark. */
export function apcaLc(text: string, background: string): number {
  const screen = (hex: string) => {
    const [r, g, b] = channels(hex).map((c) => c ** 2.4)
    const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
    return y > 0.022 ? y : y + (0.022 - y) ** 1.414
  }
  const [txt, bg] = [screen(text), screen(background)]
  if (Math.abs(bg - txt) < 0.0005) return 0
  if (bg > txt) {
    const contrast = (bg ** 0.56 - txt ** 0.57) * 1.14
    return contrast < 0.1 ? 0 : (contrast - 0.027) * 100
  }
  const contrast = (bg ** 0.65 - txt ** 0.62) * 1.14
  return contrast > -0.1 ? 0 : (contrast + 0.027) * 100
}
