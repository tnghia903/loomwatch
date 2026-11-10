import { describe, expect, it } from 'vitest'

import { groundOf, layerPaint, recolored } from './mapLook'

describe('the map’s look', () => {
  it('paints the ground, parks, water, streets and words in the theme’s colours', () => {
    expect(layerPaint('background', 'background', 'light')).toEqual({ 'background-color': '#f6f4ef' })
    expect(layerPaint('background', 'background', 'dark')).toEqual({ 'background-color': '#2e3338' })
    expect(layerPaint('park', 'fill', 'dark')).toEqual({ 'fill-color': '#2d4a40' })
    expect(layerPaint('water', 'fill', 'light')).toEqual({ 'fill-color': '#aad3f2' })
    expect(layerPaint('building', 'fill', 'dark')).toEqual({ 'fill-color': '#3a4047', 'fill-outline-color': '#444b52' })
    expect(layerPaint('highway_minor', 'line', 'light')).toEqual({ 'line-color': '#ffffff' })
    expect(layerPaint('highway_major_casing', 'line', 'dark')).toEqual({ 'line-color': '#2a2e33' })
    expect(layerPaint('highway_motorway_inner', 'line', 'light')).toEqual({ 'line-color': '#ffe7a3' })
    expect(layerPaint('railway_dashline', 'line', 'dark')).toEqual({ 'line-color': '#2e3338' })
    expect(layerPaint('label_city', 'symbol', 'dark')).toEqual({ 'text-color': '#e6e8eb', 'text-halo-color': '#2e3338' })
    expect(layerPaint('water_name_point_label', 'symbol', 'light')).toEqual({ 'text-color': '#4a7fb5', 'text-halo-color': '#ffffff' })
    expect(layerPaint('highway-name-minor', 'symbol', 'light')).toEqual({ 'text-color': '#5c5c60', 'text-halo-color': '#ffffff' })
    expect(groundOf('dark')).toBe('#2e3338')
  })

  it('leaves a layer it doesn’t name as it is, and keeps the rest of a layer’s paint', () => {
    expect(layerPaint('something_new', 'fill', 'dark')).toEqual({})
    expect(layerPaint('hillshade', 'hillshade', 'light')).toEqual({})
    const style = {
      version: 8,
      layers: [
        { id: 'park', type: 'fill', paint: { 'fill-color': 'rgb(230, 233, 229)', 'fill-opacity': 0.7 } },
        { id: 'something_new', type: 'fill', paint: { 'fill-color': 'red' } },
      ],
    }
    const dark = recolored(style, 'dark')
    expect(dark.version).toBe(8)
    expect(dark.layers[0].paint).toEqual({ 'fill-color': '#2d4a40', 'fill-opacity': 0.7 })
    expect(dark.layers[1]).toBe(style.layers[1])
    expect(style.layers[0].paint['fill-color']).toBe('rgb(230, 233, 229)')
  })
})
