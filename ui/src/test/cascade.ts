import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// jsdom paints nothing, so a test that asks "is this button gold?" runs the cascade itself: every
// rule of the app's stylesheets, in index.css's order, matched with the element's own `matches`.
// Read from disk: vitest hands a `?raw` stylesheet import back empty.

export type Rule = { selectors: string; body: string; media: string[] }
/** What the window is like, for the `@media` rules: its width, and whether motion is reduced. */
export type Viewport = { width: number; reducedMotion?: boolean }

export const DESKTOP: Viewport = { width: 1440 }
export const PHONE: Viewport = { width: 390 }

const source = resolve(process.cwd(), 'src')
const uncommented = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** A sheet's style rules, each with the `@media` conditions it sits in. Keyframes, font faces and
 *  container queries are left out: none of them styles an element by itself on a desktop or phone.
 *  (Tailwind reads this file for class names, so the at-rule's own name stays out of this comment.) */
export function rulesOf(css: string): Rule[] {
  const text = uncommented(css)
  const rules: Rule[] = []
  const open: (string | null | 'skip')[] = []
  let start = 0
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] === '}') { open.pop(); start = at + 1; continue }
    if (text[at] !== '{') continue
    const prelude = text.slice(start, at).split(';').at(-1)!.trim()
    start = at + 1
    if (prelude.startsWith('@')) {
      open.push(prelude.startsWith('@media') ? prelude.slice('@media'.length).trim() : /^@(supports|layer)\b/.test(prelude) ? null : 'skip')
      continue
    }
    const close = text.indexOf('}', at)
    if (!open.includes('skip')) rules.push({ selectors: prelude, body: text.slice(at + 1, close), media: open.filter((one): one is string => one !== null) })
    at = close
    start = close + 1
  }
  return rules
}

/** Every rule the app loads, in the order the browser cascades them: index.css's imports, then its own. */
export const appRules: Rule[] = (() => {
  const index = readFileSync(resolve(source, 'index.css'), 'utf8')
  const imported = [...index.matchAll(/@import '\.\/(styles\/[\w-]+\.css)'/g)].map(([, path]) => readFileSync(resolve(source, path), 'utf8'))
  return [...imported, index.replace(/@import [^;]+;/g, '')].flatMap(rulesOf)
})()

const feature = (condition: string, viewport: Viewport): boolean => {
  const [name, value] = condition.replace(/[()]/g, '').split(':').map((part) => part.trim())
  const length = Number.parseFloat(value)
  switch (name) {
    case 'max-width': return viewport.width <= length
    case 'min-width': return viewport.width >= length
    case 'prefers-reduced-motion': return (value === 'reduce') === Boolean(viewport.reducedMotion)
    case 'hover': return value === 'hover'
    case 'max-height': return false
    case 'min-height': return true
    default: return false
  }
}
/** Whether one `@media` prelude holds: a comma is "or", `and` joins its features. */
export const mediaHolds = (prelude: string, viewport: Viewport) =>
  prelude.split(',').some((query) => query.trim().split(/\s+and\s+/).every((part) => /^(screen|all)$/.test(part.trim()) || feature(part, viewport)))

// Split at the commas outside brackets: `:not(a, b)` is one selector.
export const topLevel = (list: string) => {
  const parts = ['']
  let depth = 0
  for (const char of list) {
    depth += char === '(' ? 1 : char === ')' ? -1 : 0
    if (char === ',' && depth === 0) parts.push('')
    else parts[parts.length - 1] += char
  }
  return parts.map((one) => one.trim()).filter(Boolean)
}

// Selectors Level 4: `:where()` counts nothing; `:not()`, `:is()` and `:has()` count their most specific argument.
export const specificity = (selector: string): number => {
  let rest = selector
  let inner = 0
  for (let call = /:(where|not|is|has)\(/.exec(rest); call; call = /:(where|not|is|has)\(/.exec(rest)) {
    let at = call.index + call[0].length
    for (let depth = 1; depth > 0 && at < rest.length; at += 1) depth += rest[at] === '(' ? 1 : rest[at] === ')' ? -1 : 0
    if (call[1] !== 'where') inner += Math.max(...topLevel(rest.slice(call.index + call[0].length, at - 1)).map(specificity))
    rest = `${rest.slice(0, call.index)} ${rest.slice(at)}`
  }
  rest = rest.replace(/\([^()]*\)/g, ' ')
  const classes = rest.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):[\w-]+/g) ?? []
  const types = [...rest.replace(/\[[^\]]*\]|[.#:][\w-]+/g, ' ').match(/[a-z][\w-]*/gi) ?? [], ...rest.match(/::[\w-]+/g) ?? []]
  return inner + (rest.match(/#[\w-]+/g) ?? []).length * 10_000 + classes.length * 100 + types.length
}

/**
 * The value of `property` the cascade gives `element` at `viewport`, or null if no rule sets it.
 * Given several names (a shorthand and its longhand), they cascade as one. `:hover` stands in as
 * an attribute, so a test can hover without a pointer: set `data-hovered`.
 */
export function cascaded(element: Element, property: string | string[], viewport: Viewport = DESKTOP, rules: Rule[] = appRules): string | null {
  let won: { important: boolean; weight: number; value: string } | null = null
  const declared = new RegExp(`(?:^|;)\\s*(?:${[property].flat().join('|')}):\\s*([^;]+)`, 'g')
  for (const { selectors, body, media } of rules) {
    const values = [...body.matchAll(declared)].map(([, value]) => value.trim())
    if (values.length === 0 || !media.every((prelude) => mediaHolds(prelude, viewport))) continue
    const raw = values.at(-1)!
    const important = /!important$/.test(raw)
    const value = raw.replace(/\s*!important$/, '')
    for (const selector of topLevel(selectors)) {
      let matches = false
      try { matches = element.matches(selector.replace(/:hover\b/g, '[data-hovered]')) } catch { /* ::before, keyframe steps */ }
      if (!matches) continue
      const weight = specificity(selector)
      if (!won || (important && !won.important) || (important === won.important && weight >= won.weight)) won = { important, weight, value }
    }
  }
  return won?.value ?? null
}

/** An element's background, whether a rule set it with the shorthand or the longhand. */
export const background = (element: Element, viewport: Viewport = DESKTOP) => cascaded(element, ['background', 'background-color'], viewport)

/** The gold fills: `--color-accent-fill`, and the dark shell's brighter `--gold` on its main button. */
export const GOLD_FILLS = ['var(--color-accent-fill)', 'var(--gold)']
export const isGoldFill = (element: Element, viewport: Viewport = DESKTOP) => GOLD_FILLS.includes(background(element, viewport) ?? '')

/** A length in px from a declared value ("32px", "44px"), or NaN for anything else (a var, a calc). */
export const px = (value: string | null) => Number(/^(-?[\d.]+)px$/.exec(value ?? '')?.[1] ?? NaN)

/** The height the cascade gives an element, in px: its `height` raised to its `min-height`. */
export const heightOf = (element: Element, viewport: Viewport = DESKTOP) =>
  Math.max(...[cascaded(element, 'height', viewport), cascaded(element, 'min-height', viewport)].map(px).filter(Number.isFinite))

/** The buttons and links on screen painted with a gold fill, by their words. */
export const goldFilled = (within: ParentNode = document, viewport: Viewport = DESKTOP) =>
  [...within.querySelectorAll('button, a')].filter((element) => isGoldFill(element, viewport)).map((element) => element.textContent?.trim() ?? '')
