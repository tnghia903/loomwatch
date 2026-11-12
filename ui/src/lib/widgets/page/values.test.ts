import { describe, expect, it } from 'vitest'

import { checkedValue, pageValues } from './values'

const pendulum = {
  inputs: [{ id: 'length', label: 'Length', start: 1, min: 0.2, max: 3, step: 0.1, unit: 'm' }, { id: 'moon', label: 'On the Moon', on: false }],
  results: [
    { id: 'swing', label: 'One swing', formula: '2 * pi * sqrt(length / if(moon, 1.62, 9.81))', unit: 's', decimals: 1 },
    { id: 'long', label: 'Long', formula: 'swing > 3' },
  ],
  presets: [{ label: 'A playground swing', values: { length: 2.5 } }],
}

describe('a page\'s figures', () => {
  it('are worked out as LoomWatch works out a calculator\'s, and written as it writes them', () => {
    const values = pageValues(pendulum)
    expect(values.inputs).toEqual({ length: 1, moon: false })
    expect(values.written).toEqual({ swing: '2.0 s', long: '0' })
    expect(values.results.long).toBe(0)
    expect(values.presets).toEqual([{ label: 'A playground swing', on: false }])
    expect(values.declared).toEqual([
      { id: 'length', label: 'Length', min: 0.2, max: 3, step: 0.1, switch: false },
      { id: 'moon', label: 'On the Moon', min: undefined, max: undefined, step: undefined, switch: true },
    ])
  })

  it('follow what the person set, and mark the preset they match', () => {
    const values = pageValues(pendulum, { values: { length: 2.5, moon: true } })
    expect(values.written.swing).toBe('7.8 s')
    expect(values.results.long).toBe(1)
    expect(pageValues(pendulum, { values: { length: 2.5 } }).presets[0].on).toBe(true)
  })

  it('are none for a page that declares none', () => {
    expect(pageValues({})).toEqual({ inputs: {}, results: {}, written: {}, presets: [], declared: [] })
  })
})

describe('what a page may set an input to', () => {
  const [length, moon] = pendulum.inputs
  it('is a number within its range, or true or false for a switch', () => {
    expect(checkedValue(length, 2.5)).toBe(2.5)
    expect(checkedValue(length, 9)).toBeNull()
    expect(checkedValue(length, 0.1)).toBeNull()
    expect(checkedValue(length, '2')).toBeNull()
    expect(checkedValue(length, Number.NaN)).toBeNull()
    expect(checkedValue(moon, true)).toBe(true)
    expect(checkedValue(moon, 1)).toBeNull()
  })
})
