import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { display, evaluate, fillNote, FormulaError, names, noteNames, parse, parseNote, workingOf } from './formula'

// The same cases the daemon reads (crates/loomwatch-backend/src/widgets/formula.rs), so a calculator
// shows the person the figures the agent was given.
interface Cases {
  evaluate: { name: string; formula: string; values: Record<string, number>; result?: number; error?: string }[]
  display: { value: number; decimals: number | null; text: string | null }[]
  notes: { name: string; note: string; values: Record<string, number>; text?: string; error?: string }[]
}
const cases = JSON.parse(readFileSync(resolve(process.cwd(), '../schemas/formula.cases.json'), 'utf8')) as Cases

describe('formula', () => {
  it('reads every case', () => {
    expect(cases.evaluate.length).toBeGreaterThan(40)
    expect(cases.display.length).toBeGreaterThan(15)
    expect(cases.notes.length).toBeGreaterThan(5)
  })

  for (const c of cases.evaluate) {
    it(`works out ${c.name}`, () => {
      if (c.error === undefined) {
        expect(evaluate(c.formula, c.values)).toBe(c.result)
        return
      }
      let thrown: unknown = null
      try { evaluate(c.formula, c.values) } catch (error) { thrown = error }
      expect(thrown).toBeInstanceOf(FormulaError)
      expect((thrown as FormulaError).kind).toBe(c.error)
      expect((thrown as FormulaError).message).not.toBe('')
    })
  }

  for (const c of cases.display) {
    it(`writes ${c.value} with ${String(c.decimals)} decimals`, () => {
      expect(display(c.value, c.decimals)).toBe(c.text)
    })
  }

  for (const c of cases.notes) {
    it(`fills in a note: ${c.name}`, () => {
      if (c.error === undefined) {
        expect(fillNote(parseNote(c.note), c.values)).toBe(c.text)
        return
      }
      let thrown: unknown = null
      try { fillNote(parseNote(c.note), c.values) } catch (error) { thrown = error }
      expect(thrown).toBeInstanceOf(FormulaError)
      expect((thrown as FormulaError).kind).toBe(c.error)
    })
  }

  it('says to close the first brace when another opens inside it', () => {
    expect(() => parseNote('{a {b}}')).toThrow('a { in a note needs a } after its formula')
  })

  it('names what a note reads, once each', () => {
    expect(noteNames(parseNote('{found} of {total} found, {found / total * 100}%'))).toEqual(['found', 'total'])
  })

  it('writes the sum out only when it is plain arithmetic', () => {
    expect(workingOf('(bus + pupils * ticket) / pupils', { bus: 2400000, pupils: 32, ticket: 60000 })).toBe('(2,400,000 + 32 × 60,000) ÷ 32')
    expect(workingOf('-a - b', { a: 1, b: 2 })).toBe('−1 − 2')
    expect(workingOf('ceil(x, -4)', { x: 1 })).toBeNull()
    expect(workingOf('(a > 30) * 5', { a: 32 })).toBeNull()
    expect(workingOf('a', { a: 32 })).toBeNull()
  })

  it('names what a formula reads, once each', () => {
    expect(names(parse('if(round_up, ceil(total / pupils, -4), total / pupils)'))).toEqual(['round_up', 'total', 'pupils'])
  })

  it('never writes a number in the browser’s locale', () => {
    const before = Number.prototype.toLocaleString
    // A German browser would write 1.234.567,5.
    Number.prototype.toLocaleString = function () { return 'locale' }
    try {
      expect(display(1234567.5)).toBe('1,234,567.5')
    } finally {
      Number.prototype.toLocaleString = before
    }
  })
})
