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

/** A rule that sets a property: its last value for it, and each of its selectors ready to match. */
type Declaring = { media: string[]; important: boolean; value: string; selectors: { selector: string; weight: number; classes: string[]; unmatchable?: boolean }[] }

const needed = new Map<string, string[]>()

/**
 * The classes an element must have for `selector` to match it: those written plainly in its last
 * compound, outside brackets and any `:not()`, `:is()` or `:where()`. An element without one of
 * them can't match, so `matches` isn't asked. None when a name is escaped, to stay safe.
 */
export function neededClasses(selector: string): string[] {
  const known = needed.get(selector)
  if (known) return known
  let plain = ''
  let depth = 0
  for (const char of selector) {
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    else if (depth === 0) plain += char
  }
  const last = plain.trim().split(/\s*[\s>+~]\s*/).at(-1) ?? ''
  const classes = last.includes('\\') ? [] : [...last.matchAll(/\.([\w-]+)/g)].map(([, name]) => name)
  needed.set(selector, classes)
  return classes
}

// Which rules set a property depends on the rules alone, so it is worked out once per set of rules
// and property. Asking it of every rule for every element made a screen's `goldFilled` take
// seconds on a busy computer: thousands of rules for each of dozens of buttons.
const declaringByRules = new WeakMap<Rule[], Map<string, Declaring[]>>()

function declaring(rules: Rule[], property: string | string[]): Declaring[] {
  const names = [property].flat().join('|')
  let byProperty = declaringByRules.get(rules)
  if (!byProperty) declaringByRules.set(rules, (byProperty = new Map()))
  const known = byProperty.get(names)
  if (known) return known
  const declared = new RegExp(`(?:^|;)\\s*(?:${names}):\\s*([^;]+)`, 'g')
  const found: Declaring[] = []
  for (const { selectors, body, media } of rules) {
    const raw = [...body.matchAll(declared)].at(-1)?.[1].trim()
    if (raw === undefined) continue
    found.push({
      media,
      important: /!important$/.test(raw),
      value: raw.replace(/\s*!important$/, ''),
      selectors: topLevel(selectors).map((selector) => ({
        selector: selector.replace(/:hover\b/g, '[data-hovered]').replace(/:focus-visible\b/g, '[data-focus-visible]'),
        weight: specificity(selector),
        classes: neededClasses(selector),
      })),
    })
  }
  byProperty.set(names, found)
  return found
}

/**
 * The value of `property` the cascade gives `element` at `viewport`, or null if no rule sets it.
 * Given several names (a shorthand and its longhand), they cascade as one. `:hover` and
 * `:focus-visible` stand in as attributes, so a test can hover without a pointer, and count on
 * keyboard focus where jsdom only guesses it from the last event: set `data-hovered` or
 * `data-focus-visible`.
 */
export function cascaded(element: Element, property: string | string[], viewport: Viewport = DESKTOP, rules: Rule[] = appRules): string | null {
  let won: { important: boolean; weight: number; value: string } | null = null
  for (const { media, important, value, selectors } of declaring(rules, property)) {
    if (!media.every((prelude) => mediaHolds(prelude, viewport))) continue
    for (const one of selectors) {
      if (one.unmatchable || !one.classes.every((name) => element.classList.contains(name))) continue
      let matches = false
      // A selector no element can match (::before, keyframe steps) throws; it is not tried again.
      try { matches = element.matches(one.selector) } catch { one.unmatchable = true }
      if (!matches) continue
      const weight = one.weight
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
