import { describe, expect, it } from 'vitest'

import { drawScale, namesFit, pinAnchor, pinRows, rangeOf, ticksThatFit } from './scale'

const fever = {
  kind: 'scale' as const,
  title: 'Is 38.5 °C a fever?',
  unit: '°C',
  decimals: 1,
  ranges: [{ label: 'Low', from: 35, to: 36.1 }, { label: 'Normal', from: 36.1, to: 37.5 }, { label: 'Fever', from: 37.5, to: 40 }],
  pins: [{ label: 'You', value: 38.5 }],
}

describe('a scale', () => {
  it('puts a figure where two ranges meet in the higher, and the very top in the last, as the daemon does', () => {
    expect(rangeOf(fever.ranges, 35)).toBe(0)
    expect(rangeOf(fever.ranges, 37.5)).toBe(2)
    expect(rangeOf(fever.ranges, 40)).toBe(2)
    expect(rangeOf(fever.ranges, 41)).toBe(-1)
    expect(rangeOf(fever.ranges, 34.9)).toBe(-1)
  })

  it('draws each range as wide as its stretch, and writes the unit once, at the end', () => {
    const { ranges, pins, ticks } = drawScale(fever)
    expect(ranges.map((range) => [range.start, range.width].map((share) => Math.round(share * 100)))).toEqual([[0, 22], [22, 28], [50, 50]])
    expect(ranges.map((range) => range.held)).toEqual([false, false, true])
    expect(pins).toEqual([{ label: 'You', figure: '38.5 °C', at: 0.7, range: 'Fever' }])
    expect(ticks.map((tick) => tick.figure)).toEqual(['35.0', '36.1', '37.5', '40.0 °C'])
  })

  it('keeps the ends’ figures and drops one between that has no room', () => {
    const ticks = [{ at: 0, figure: '0' }, { at: 0.02, figure: '1' }, { at: 0.5, figure: '50' }, { at: 1, figure: '100 km' }]
    expect(ticksThatFit(ticks, 300).map((tick) => tick.figure)).toEqual(['0', '50', '100 km'])
    // On a phone the ends stand from the edges, so a figure near either end gives way to them.
    const { ticks: fever4 } = drawScale({ ...fever, ranges: [...fever.ranges.slice(0, 2), { label: 'Fever', from: 37.5, to: 39.5 }, { label: 'High fever', from: 39.5, to: 41 }] })
    expect(ticksThatFit(fever4, 238).map((tick) => tick.figure)).toEqual(['35.0', '37.5', '41.0 °C'])
    expect(ticksThatFit(fever4, 570).map((tick) => tick.figure)).toEqual(['35.0', '36.1', '37.5', '39.5', '41.0 °C'])
  })

  it('numbers ranges too narrow for their names, and lifts a pin whose name would cross another’s', () => {
    const { ranges, pins } = drawScale({ ...fever, pins: [{ label: 'You', value: 38.5 }, { label: 'Your child', value: 38.7 }] })
    expect(namesFit(ranges, 570)).toBe(true)
    expect(namesFit(ranges, 120)).toBe(false)
    expect(pinRows(pins, 570)).toEqual([0, 1])
    expect(pinRows([pins[0], { ...pins[1], at: 0.1 }], 570)).toEqual([0, 0])
  })

  it('stands a pin’s name from the bar’s end when centred it would cross the card’s edge', () => {
    const pin = (at: number) => ({ label: 'Your reading today', figure: '41.0 °C', at, range: null })
    expect(pinAnchor(pin(0.5), 300)).toBe('')
    expect(pinAnchor(pin(0), 300)).toBe('first')
    expect(pinAnchor(pin(1), 300)).toBe('last')
    // Two names at the top end, anchored there, still go to two rows.
    expect(pinRows([pin(0.98), pin(1)], 300)).toEqual([0, 1])
  })
})
