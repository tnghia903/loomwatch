import { expect, it } from 'vitest'

import { foldCredit } from './mapCredit'

it('folds the maps’ credit into its (i) from the start, leaving the (i) to open it', () => {
  const box = document.createElement('div')
  box.innerHTML = '<div class="maplibregl-ctrl maplibregl-ctrl-attrib maplibregl-compact maplibregl-compact-show"><button class="maplibregl-ctrl-attrib-button"></button><div class="maplibregl-ctrl-attrib-inner">OpenFreeMap © OpenMapTiles Data from OpenStreetMap</div></div>'
  foldCredit(box)
  const credit = box.querySelector('.maplibregl-ctrl-attrib')!
  expect(credit.classList.contains('maplibregl-compact-show')).toBe(false)
  // Still there, for the (i) to open: the map's data and tiles ask for it.
  expect(credit.textContent).toContain('OpenStreetMap')
  expect(credit.querySelector('.maplibregl-ctrl-attrib-button')).toBeTruthy()
})

it('leaves a map with no credit yet as it is', () => {
  expect(() => foldCredit(document.createElement('div'))).not.toThrow()
  expect(() => foldCredit(null)).not.toThrow()
})
