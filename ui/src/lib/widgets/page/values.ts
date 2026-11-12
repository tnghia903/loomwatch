import { valuesOf, workOut } from '../calculator'
import { evaluateFormula, FormulaError, parse } from '../formula'
import type { WidgetFigure, WidgetInput, WidgetPreset, WidgetState } from '../types'

/** What a page is sent each time its figures change (ADR 0125): its inputs as set, its results as
    numbers and as LoomWatch writes them, its presets, and what its inputs may be. */
export interface PageValues {
  inputs: Record<string, number | boolean>
  results: Record<string, number | null>
  written: Record<string, string | null>
  presets: { label: string; on: boolean }[]
  declared: { id: string; label: string; min?: number; max?: number; step?: number; switch: boolean }[]
}

export interface PageSums { inputs?: WidgetInput[]; results?: WidgetFigure[]; presets?: WidgetPreset[] }

/** A page's figures with its inputs as in `state`, worked out as a calculator's are. */
export function pageValues(page: PageSums, state?: WidgetState): PageValues {
  const inputs = page.inputs ?? []
  const results = page.results ?? []
  const numbers = valuesOf(inputs, state)
  const switches = new Set(inputs.filter((input) => input.on !== undefined).map((input) => input.id))
  const known: Record<string, number> = { ...numbers }
  const out: PageValues = { inputs: {}, results: {}, written: {}, presets: [], declared: [] }
  for (const input of inputs) {
    out.inputs[input.id] = switches.has(input.id) ? numbers[input.id] !== 0 : numbers[input.id]
    out.declared.push({ id: input.id, label: input.label, min: input.min, max: input.max, step: input.step, switch: switches.has(input.id) })
  }
  const worked = workOut(results, numbers, switches)
  results.forEach((figure, at) => {
    try {
      const value = evaluateFormula(parse(figure.formula), known)
      known[figure.id] = value
      out.results[figure.id] = value
    } catch (error) {
      if (!(error instanceof FormulaError)) throw error
      out.results[figure.id] = null
    }
    out.written[figure.id] = worked[at]?.text ?? null
  })
  out.presets = (page.presets ?? []).map((preset) => ({
    label: preset.label,
    on: inputs.every((input) => {
      const given = preset.values[input.id]
      const now = out.inputs[input.id]
      return given === undefined ? now === (input.on ?? input.start) : given === now
    }),
  }))
  return out
}

/** `value` as input `input` takes it, or null: a switch true or false, a number within its min
    and max. */
export function checkedValue(input: WidgetInput, value: unknown): number | boolean | null {
  if (input.on !== undefined) return typeof value === 'boolean' ? value : null
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if ((input.min !== undefined && value < input.min) || (input.max !== undefined && value > input.max)) return null
  return value
}
