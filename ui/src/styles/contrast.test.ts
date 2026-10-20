import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Every stylesheet the app loads, read from disk (a `?raw` import is empty under vitest, which would
// make these checks pass on nothing), in the order index.css imports them, index.css's own rules last.
const read = (path: string) => readFileSync(resolve(process.cwd(), 'src', path), 'utf8')
const imported = [...read('index.css').matchAll(/@import '\.\/styles\/([\w-]+\.css)'/g)].map(([, name]) => name)
const sheets: [string, string][] = [
  ...imported,
  ...readdirSync(resolve(process.cwd(), 'src/styles')).filter((name) => name.endsWith('.css') && !imported.includes(name)),
].map((name): [string, string] => [name, read(`styles/${name}`)]).concat([['index.css', read('index.css')]])

type Rule = { where: string; selector: string; body: string }
type Shape = { rule: Rule; order: number; compounds: Set<string>[]; context: string; weight: number[] }

/** Every rule with a body, inside @media and the like too. Comments are blanked, so line numbers hold. */
function rulesOf(name: string, css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => {
    const start = match.index + match[1].search(/\S/)
    return { where: `${name}:${text.slice(0, start).split('\n').length}`, selector: match[1].trim().replace(/\s+/g, ' '), body: match[2] }
  })
}

/** Splits at `at` outside brackets and parentheses: a list at its commas, a selector at its combinators. */
function topLevel(text: string, at: RegExp): string[] {
  const parts: string[] = []
  let depth = 0
  let part = ''
  for (const char of text) {
    if ('(['.includes(char)) depth++
    if (')]'.includes(char)) depth--
    if (depth === 0 && at.test(char)) { parts.push(part); part = '' } else part += char
  }
  return [...parts, part].map((one) => one.trim()).filter(Boolean)
}

/** A compound selector as its simple parts, quotes dropped: `a.b[x='1']:hover` → a, .b, [x=1], :hover. */
const partsOf = (compound: string) => [...compound.matchAll(/\.[\w-]+|#[\w-]+|\[[^\]]*\]|::?[\w-]+(?:\((?:[^()]|\([^()]*\))*\))?|^[a-z][\w-]*|\*/gi)]
  .map(([part]) => part.replace(/['"]|\s+/g, ''))

/** CSS specificity as [ids, classes, types]; `:is()` and `:not()` count their heaviest argument. */
function weigh(parts: string[]): number[] {
  return parts.reduce((sum, part) => {
    const inner = /^:(is|not|has)\((.*)\)$/.exec(part)
    const one = part.startsWith(':where(') ? [0, 0, 0]
      : inner ? topLevel(inner[2], /,/).map((arg) => weigh(topLevel(arg, /[\s>+~]/).flatMap(partsOf))).sort(compare).pop() ?? [0, 0, 0]
        : part.startsWith('#') ? [1, 0, 0]
          : /^(\.|\[|:(?!:))/.test(part) ? [0, 1, 0]
            : part === '*' ? [0, 0, 0] : [0, 0, 1]
    return sum.map((value, index) => value + one[index])
  }, [0, 0, 0])
}
function compare(one: number[], other: number[]) {
  return one[0] - other[0] || one[1] - other[1] || one[2] - other[2]
}

/** A rule's selectors, each as its compounds and weight. A keyframe's stops (`from`, `30%`) are not selectors. */
function shapesOf(list: [string, string][]): Shape[] {
  const stop = /^(?:from|to|\d+(?:\.\d+)?%)$/
  return list.flatMap(([name, css]) => rulesOf(name, css)).flatMap((rule) => topLevel(rule.selector, /,/).filter((one) => !stop.test(one)).map((one) => {
    const compounds = topLevel(one, /[\s>+~]/)
    return { rule, compounds: compounds.map((compound) => new Set(partsOf(compound))), context: compounds.slice(0, -1).join(' '), weight: weigh(compounds.flatMap(partsOf)) }
  })).map((shape, order) => ({ ...shape, order }))
}
const shapes = shapesOf(sheets)

const subject = (shape: Shape) => shape.compounds[shape.compounds.length - 1]
const within = (one: Set<string>, other: Set<string>) => [...one].every((part) => other.has(part))
/** Which of two rules on one element wins a property both set: the more specific, or else the later. */
const beats = (one: Shape, other: Shape) => compare(one.weight, other.weight) > 0 || (compare(one.weight, other.weight) === 0 && one.order > other.order)
const values = (rule: Rule, property: string) => [...rule.body.matchAll(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'g'))]
  .map(([, value]) => value.replace(/!important/, '').trim())
/** Text in the accent: `--gold` is its name inside the prototype shell (prototype-parity.css). */
const goldText = (rule: Rule) => values(rule, 'color').some((value) => /^var\(--(?:color-accent|gold)\)$/.test(value))
/** The gold tint, whole or mixed, or a wash of the accent itself: from 5% it takes gold under 4.5:1 on the ground. */
const tinted = (rule: Rule) => [...values(rule, 'background'), ...values(rule, 'background-color')].some((value) =>
  /var\(--(?:color-accent-tint|gold-tint)\)/.test(value)
  || [...value.matchAll(/var\(--(?:color-accent|gold)\)\s+(\d+(?:\.\d+)?)%/g)].some(([, share]) => Number(share) >= 5))
const ownsColour = (rule: Rule) => values(rule, 'color').length > 0
const ownsBackground = (rule: Rule) => values(rule, 'background').length + values(rule, 'background-color').length > 0
/** An icon is not text: a gold glyph on the tint needs 3:1, and gold on the tint is 4.45:1 or more. */
const glyph = (shape: Shape) => subject(shape).has('svg')
const where = (shape: Shape) => `${shape.rule.where} ${shape.rule.selector}`

/**
 * Gold words on the gold tint. Gold on the tint is 4.45:1 in light, under the 4.5 text needs; ink is
 * 16:1 in both themes (DESIGN_LANGUAGE §4, rule 2). Three ways a sheet puts them together:
 * - one rule sets both;
 * - a gold element is tinted by another rule on it, such as a state (`:hover`, `[aria-pressed]`) or a
 *   broader rule it also matches, and the cascade keeps both the gold and the tint;
 * - a rule colours the words of something whose ancestor, as its selector names it, has the tint.
 */
function goldOnTint(list: Shape[]): string[] {
  const gold = list.filter((shape) => goldText(shape.rule) && !glyph(shape))
  const tints = list.filter((shape) => tinted(shape.rule))
  const same = gold.filter((shape) => tinted(shape.rule)).map(where)
  const states = gold.flatMap((shape) => tints
    .filter((tint) => tint.rule !== shape.rule
      && (tint.context === shape.context || !tint.context)
      && (within(subject(shape), subject(tint)) || within(subject(tint), subject(shape)))
      && (!ownsColour(tint.rule) || beats(shape, tint))
      && (!ownsBackground(shape.rule) || beats(tint, shape)))
    .map((tint) => `${where(shape)} on ${where(tint)}`))
  const nested = gold.filter((shape) => !ownsBackground(shape.rule)).flatMap((shape) => tints
    .filter((tint) => shape.compounds.slice(0, -1).some((ancestor) => within(subject(tint), ancestor)))
    .map((tint) => `${where(shape)} inside ${where(tint)}`))
  return [...same, ...states, ...nested]
}

/** A key hint is part of its button's label: dimming it with opacity drops its letter under 4.5:1. */
const dimKeys = (list: Shape[]) => list
  .filter((shape) => subject(shape).has('kbd') && values(shape.rule, 'opacity').some((value) => Number(value) < 1))
  .map(where)

const sample = (css: string) => shapesOf([['sample.css', css]])

describe('every stylesheet', () => {
  it('is read, rules inside @media too', () => {
    expect(imported.length).toBeGreaterThan(25)
    for (const [name, css] of sheets) expect(css.length, name).toBeGreaterThan(0)
    expect(shapes.length).toBeGreaterThan(2000)
    expect(shapes.some((shape) => shape.rule.selector === '.needs-you-bell .needs-you-label')).toBe(true)
    // The tint is used, with ink words, all over: the checks below have something to look at.
    expect(shapes.filter((shape) => tinted(shape.rule)).length).toBeGreaterThan(40)
  })

  it('never puts gold words on the gold tint', () => {
    expect(goldOnTint(shapes)).toEqual([])
  })

  it('never dims a key hint with opacity', () => {
    expect(dimKeys(shapes)).toEqual([])
  })
})

// The checks themselves, on small sheets: each way of writing the slip is caught, and what is fine passes.
describe('the gold-on-tint check', () => {
  it('catches gold words and the tint in one rule, through either name, mixed, or in @media', () => {
    expect(goldOnTint(sample('.a.on { background: var(--color-accent-tint); color: var(--color-accent); }'))).toHaveLength(1)
    expect(goldOnTint(sample('.lw-shell .b { color:var(--gold); background:var(--gold-tint); }'))).toHaveLength(1)
    expect(goldOnTint(sample('.c { background: color-mix(in srgb, var(--color-accent-tint) 70%, transparent); color: var(--color-accent) !important; }'))).toHaveLength(1)
    expect(goldOnTint(sample('.d:hover { background: color-mix(in srgb, var(--color-accent) 14%, var(--color-panel-solid)); color: var(--color-accent); }'))).toHaveLength(1)
    expect(goldOnTint(sample('.d2 { background: color-mix(in srgb, var(--color-accent) 60%, transparent); color: var(--color-accent); }'))).toHaveLength(1)
    expect(goldOnTint(sample('@media (max-width: 767px) { .e { background: var(--color-accent-tint); color: var(--color-accent); } }'))).toHaveLength(1)
  })

  it('catches a gold element that a state or a broader rule tints', () => {
    expect(goldOnTint(sample('.f { color: var(--color-accent); background: transparent; } .f:hover:not(:disabled) { background: var(--color-accent-tint); }'))).toHaveLength(1)
    expect(goldOnTint(sample('.g .h > .i { color: var(--color-accent); } .g .h > .i:hover { background: var(--color-accent-tint); }'))).toHaveLength(1)
    expect(goldOnTint(sample('.j, .j2 { background: var(--color-accent-tint); color: var(--color-ink); } .j:hover { color: var(--color-accent); }'))).toHaveLength(1)
    expect(goldOnTint(sample('.k { background: var(--gold-tint); color: var(--color-ink); } .node .k { color: var(--color-accent); }'))).toHaveLength(1)
  })

  it('catches gold words inside a tinted ancestor the selector names', () => {
    expect(goldOnTint(sample(".l[aria-pressed='true'] { background: var(--color-accent-tint); } .l[aria-pressed=\"true\"] em { color: var(--color-accent); }"))).toHaveLength(1)
    expect(goldOnTint(sample('.m { background: var(--color-accent-tint); } .m .t-micro { color: var(--color-accent); }'))).toHaveLength(1)
  })

  it('passes ink on the tint, gold icons on it, gold borders and rings, and gold words elsewhere', () => {
    expect(goldOnTint(sample(`
      .n.on { background: var(--color-accent-tint); color: var(--color-ink); border-color: var(--color-accent); box-shadow: inset 0 0 0 1px var(--color-accent); }
      .n.on > svg { color: var(--color-accent); }
      .o { color: var(--color-accent); background: transparent; } .o:hover { background: var(--color-accent-tint); color: var(--color-ink); }
      .p { background: var(--color-accent-tint); } .q { color: var(--color-accent); }
      .r { color: var(--color-accent); background: var(--color-panel-solid); } .s .r { background: var(--color-accent-tint); color: var(--color-ink); }
      .t, .t2 { color: var(--color-ink); background: var(--color-accent-tint); } .t2 { color: var(--color-accent); background: transparent; }
      .u { background: color-mix(in srgb, var(--color-accent) 4%, transparent); } .u .head { color: var(--color-accent); }
      .w { color: var(--color-accent-fill); background: var(--color-accent-tint); border: 1px solid color-mix(in srgb, var(--color-accent) 40%, transparent); }
      .x button:hover { background: var(--color-accent-tint); } button.y:hover { color: var(--color-accent); }
      .side .v { background: var(--color-accent-tint); } .other .v { color: var(--color-accent); }
    `))).toEqual([])
  })

  it('weighs selectors as the browser does', () => {
    expect(weigh(partsOf('a.b[x]:hover::before'))).toEqual([0, 3, 2])
    expect(weigh(['#id', ...partsOf('.c:not(.d, #e)')])).toEqual([2, 1, 0])
    expect(weigh(partsOf('.f:where(.g, #h)'))).toEqual([0, 1, 0])
  })
})

describe('the key-hint check', () => {
  it('catches a dimmed kbd and passes a faint box with a full-strength letter', () => {
    expect(dimKeys(sample('.save kbd { opacity: .7; }'))).toHaveLength(1)
    expect(dimKeys(sample('.lw-composer .comp-act .btn kbd { font: 500 11px/1 var(--font-mono); opacity: 0.75; }'))).toHaveLength(1)
    expect(dimKeys(sample('.ticket-acts kbd { border: 1px solid color-mix(in srgb, currentColor 40%, transparent); } .btn:disabled { opacity: .5; } kbd.key { opacity: 1; }'))).toEqual([])
  })
})
