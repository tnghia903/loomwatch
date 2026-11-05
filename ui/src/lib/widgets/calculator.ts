import { display, evaluateFormula, FormulaError, names, parse, workingOf } from './formula'
import type { WidgetFigure, WidgetInput, WidgetState } from './types'

/** A calculator's input values: the starting ones, with yours from `state` over them. A switch is
    1 when on, as formulas read it. */
export function valuesOf(inputs: readonly WidgetInput[], state?: WidgetState): Record<string, number> {
  const changed = state && 'values' in state ? state.values : {}
  const values: Record<string, number> = {}
  for (const input of inputs) {
    const given = changed[input.id]
    if (input.on !== undefined) values[input.id] = (typeof given === 'boolean' ? given : input.on) ? 1 : 0
    else values[input.id] = typeof given === 'number' ? given : input.start ?? 0
  }
  return values
}

/** One result as you read it: its figure, written, and how it was worked out when that is plain. */
export interface WorkedOut {
  label: string
  /** "135,000 ₫"; null when it can't be worked out with these numbers. */
  text: string | null
  /** "(2,400,000 + 32 × 60,000) ÷ 32", for plain arithmetic on numbers; null for a formula with a
      function, a comparison or a switch in it, which would read as code. */
  working: string | null
}

/** A calculator's results with `values`, in order: each reads the inputs and the results above it.
    `switches` are the inputs that are on or off. */
export function workOut(results: readonly WidgetFigure[], values: Readonly<Record<string, number>>, switches: ReadonlySet<string> = new Set()): WorkedOut[] {
  const known: Record<string, number> = { ...values }
  return results.map((figure) => {
    try {
      const formula = parse(figure.formula)
      const value = evaluateFormula(formula, known)
      known[figure.id] = value
      const number = display(value, figure.decimals ?? null)
      return {
        label: figure.label,
        text: number === null ? null : `${figure.prefix ?? ''}${number}${figure.unit ? ` ${figure.unit}` : ''}`,
        working: names(formula).some((name) => switches.has(name)) ? null : workingOf(figure.formula, known),
      }
    } catch (error) {
      if (!(error instanceof FormulaError)) throw error
      return { label: figure.label, text: null, working: null }
    }
  })
}

/** "60.000" or "2.400.000": thousands written with dots, as many people write them. Read as such
    they would be a fraction, so the calculator asks for commas instead of guessing. */
export function thousandsWithDots(typed: string): boolean {
  return /^-?\d{1,3}(\.\d{3})+$/u.test(typed.replace(/\s/gu, ''))
}

/** A number still being typed ('', '-', '12.'): not a value yet, and not wrong either. */
export function stillTyping(typed: string): boolean {
  return /^-?(\d+\.?)?$/u.test(typed.replace(/[,\s]/gu, '')) && readNumber(typed) === null
}

/** A number you typed, read as LoomWatch writes them ("2,400,000", "12.5"), or null. */
export function readNumber(typed: string): number | null {
  if (thousandsWithDots(typed)) return null
  const plain = typed.replace(/[,\s]/gu, '')
  if (!/^-?\d+(\.\d+)?$/u.test(plain)) return null
  const value = Number(plain)
  return Number.isFinite(value) ? value : null
}

/** An input's number as it starts in its box: grouped like a result, with up to six decimals and
    no trailing zeros. */
export function inputText(value: number): string {
  const written = display(value, 6)
  if (written === null) return String(value)
  return written.includes('.') ? written.replace(/0+$/u, '').replace(/\.$/u, '') : written
}
