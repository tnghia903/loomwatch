import { describe, expect, it } from 'vitest'

import { away, directions, distance, facts, fanned, frame, metres, website } from './map'
import type { WidgetPlace } from './types'

const bread: WidgetPlace = { name: 'Bread Yard', lat: 1.29875, lng: 103.78761, category: 'cafe', rating: 4.8, price: 2, link: 'https://breadyard.sg/' }
const galaxis = { name: 'Galaxis', lat: 1.29947, lng: 103.78753 }

describe('a map’s distances', () => {
  it('reads each one as the daemon tells the agent', () => {
    // The daemon's own cases (`widgets/map/tests.rs`), so the map and the agent's words agree.
    expect(distance(0)).toBe('10 m')
    expect(distance(3)).toBe('10 m')
    expect(distance(344)).toBe('340 m')
    expect(distance(345)).toBe('350 m')
    expect(distance(994)).toBe('990 m')
    expect(distance(995)).toBe('1 km')
    expect(distance(1_249)).toBe('1.2 km')
    expect(distance(1_250)).toBe('1.3 km')
    expect(distance(9_949)).toBe('9.9 km')
    expect(distance(9_950)).toBe('10 km')
    expect(distance(12_345)).toBe('12 km')
    expect(distance(1_240_499)).toBe('1,240 km')
    expect(distance(16_935_577)).toBe('16,936 km')
  })

  it('reckons them along the Earth, as the crow flies', () => {
    expect(metres({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111_195.08, 1)
    expect(metres(galaxis, { lat: 1.30561, lng: 103.79213 })).toBeCloseTo(853.01, 1)
    expect(away(bread, galaxis)).toBe('80 m from Galaxis')
    expect(away(bread)).toBeNull()
  })
})

describe('a place’s facts and links', () => {
  it('writes its rating, price and sort as a maps app does', () => {
    expect(facts(bread)).toEqual({ rating: '4.8', rest: ['$$', 'Café'] })
    expect(facts({ name: 'Park', lat: 1, lng: 1, category: 'park', rating: 4 })).toEqual({ rating: '4.0', rest: ['Park'] })
    expect(facts({ name: 'Somewhere', lat: 1, lng: 1, category: 'other' })).toEqual({ rating: null, rest: [] })
    // What the daemon never keeps is left out, not drawn wrong.
    expect(facts({ name: 'Odd', lat: 1, lng: 1, rating: 9, price: 7 })).toEqual({ rating: null, rest: [] })
  })

  it('opens directions in Apple Maps or Google Maps, by name and address when it has one', () => {
    expect(directions(bread, 'apple')).toBe('https://maps.apple.com/?daddr=1.29875%2C103.78761')
    expect(directions(bread, 'google')).toBe('https://www.google.com/maps/dir/?api=1&destination=1.29875%2C103.78761')
    const addressed = { ...bread, address: '1 Fusionopolis Way' }
    expect(directions(addressed, 'apple')).toBe('https://maps.apple.com/?daddr=Bread%20Yard%2C%201%20Fusionopolis%20Way')
    expect(directions(addressed, 'google')).toBe('https://www.google.com/maps/dir/?api=1&destination=Bread%20Yard%2C%201%20Fusionopolis%20Way')
  })

  it('opens only a web address as its website', () => {
    expect(website(bread)).toBe('https://breadyard.sg/')
    expect(website({ ...bread, link: 'javascript:alert(1)' })).toBeNull()
    expect(website({ ...bread, link: 'not a link' })).toBeNull()
    expect(website({ ...bread, link: undefined })).toBeNull()
  })

  it('frames every place and where you start', () => {
    expect(frame([bread, { ...bread, lat: 1.30561, lng: 103.79213 }], galaxis)).toEqual([[103.78753, 1.29875], [103.79213, 1.30561]])
  })
})

describe('places on one spot', () => {
  it('fan round it so each pin shows, and a place on its own stays put', () => {
    const galaxis = { lat: 1.29979, lng: 103.78835 }
    const three = [galaxis, { ...galaxis }, { lat: 1.29983, lng: 103.78838 }, { lat: 1.30561, lng: 103.79213 }]
    expect(fanned(three)).toEqual([
      { dx: 0, dy: -22 },
      { dx: 19, dy: 11 },
      { dx: -19, dy: 11 },
      { dx: 0, dy: 0 },
    ])
    expect(fanned([galaxis])).toEqual([{ dx: 0, dy: 0 }])
    // Two shops 40 m apart are two spots.
    expect(fanned([galaxis, { lat: 1.30015, lng: 103.78835 }])).toEqual([{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }])
  })
})
