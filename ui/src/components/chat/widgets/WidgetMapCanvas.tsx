import 'maplibre-gl/dist/maplibre-gl.css'

import { AttributionControl, Map as MapLibre, Marker, setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { useEffect, useRef, useState } from 'react'

import { useTheme } from '../../../lib/theme'
import { frame, MAP_STYLE } from '../../../lib/widgets/map'
import { groundOf, layerPaint, recolored, type MapTheme } from '../../../lib/widgets/mapLook'
import type { WidgetPlace, WidgetStart } from '../../../lib/widgets/types'
import { glyphMarkup } from './placeGlyphs'

setWorkerUrl(workerUrl)

export interface MapCanvasProps {
  places: readonly WidgetPlace[]
  from?: WidgetStart
  /** The place in focus: its pin stands out, and the map moves to it when it changes. */
  picked: number
  onPick: (at: number) => void
  /** Room the map keeps clear of pins at each side, for what lies over it: the cards along the
      bottom of the small map, or the place's panel beside the large one. */
  room: { top: number; right: number; bottom: number; left: number }
  /** The small map in an answer: it only zooms with ⌘ or Ctrl held, so the chat scrolls past it. */
  small?: boolean
  /** The corner the maps' credit stands in, clear of what lies over the map. */
  credit?: 'top-left' | 'bottom-right'
}

const quiet = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

/** The map's layers in the theme's colours (`mapLook.ts`). */
function repaint(map: MapLibre, theme: MapTheme) {
  for (const layer of map.getStyle()?.layers ?? []) {
    for (const [property, color] of Object.entries(layerPaint(layer.id, layer.type, theme))) {
      map.setPaintProperty(layer.id, property as Parameters<MapLibre['setPaintProperty']>[1], color)
    }
  }
}

/**
 * Pins' names where they fit: the one in focus always, then the rest in order, each shown only if
 * it clears every mark and the names already shown, as a maps app thins its labels.
 */
function declutter(pins: readonly HTMLButtonElement[], picked: number) {
  const taken: DOMRect[] = pins.map((pin) => pin.querySelector('.wg-pin-mark')?.getBoundingClientRect()).filter((rect): rect is DOMRect => !!rect)
  const order = [picked, ...pins.keys()].filter((at, index, all) => at < pins.length && all.indexOf(at) === index)
  for (const at of order) {
    const name = pins[at].querySelector<HTMLElement>('.wg-pin-name')
    const mark = pins[at].querySelector('.wg-pin-mark')?.getBoundingClientRect()
    if (!name) continue
    name.style.visibility = 'visible'
    const rect = name.getBoundingClientRect()
    const clashes = at !== picked && taken.some((other) => other !== mark && !(other.right <= rect.left || other.left >= rect.right || other.bottom <= rect.top || other.top >= rect.bottom))
    if (clashes) name.style.visibility = 'hidden'
    else taken.push(rect)
  }
}

/**
 * The map itself, from OpenFreeMap's OpenStreetMap tiles in the app's light or dark: a pin for
 * each place, marked by what sort of place it is and named under it where the name fits, and a
 * blue dot where you start. It opens framed on all of them. Loaded only when a map is shown
 * (`WidgetMap`).
 */
export default function WidgetMapCanvas({ places, from, picked, onPick, room, small = false, credit = 'top-left' }: MapCanvasProps) {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<MapLibre | null>(null)
  const pins = useRef<HTMLButtonElement[]>([])
  const pick = useRef(onPick)
  const { resolved } = useTheme()
  const theme = useRef(resolved)
  const [broken, setBroken] = useState(false)
  const shown = useRef(picked)

  useEffect(() => { pick.current = onPick }, [onPick])

  useEffect(() => {
    if (!box.current) return
    let drawn: MapLibre
    try {
      drawn = new MapLibre({
        container: box.current,
        style: MAP_STYLE,
        transformStyle: (_, next) => recolored(next, theme.current),
        attributionControl: false,
        cooperativeGestures: small,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        maxZoom: 18,
        bounds: frame(places, from),
        fitBoundsOptions: { padding: padding(room), maxZoom: 16 },
      })
    } catch (error) {
      console.error('LoomWatch could not draw a map', error)
      setBroken(true)
      return
    }
    drawn.touchZoomRotate.disableRotation()
    drawn.addControl(new AttributionControl({ compact: true }), credit)
    // The maps' credit shows when the map first draws and folds into its (i) once you move the
    // map, as OpenStreetMap's credit rules ask: MapLibre's own way, left as it is.
    drawn.on('load', () => declutter(pins.current, shown.current))
    drawn.on('moveend', () => declutter(pins.current, shown.current))
    // Before the tiles come, the pins already stand where they belong.
    const placed = requestAnimationFrame(() => declutter(pins.current, shown.current))
    map.current = drawn
    pins.current = places.map((place, at) => {
      const pin = document.createElement('button')
      pin.type = 'button'
      pin.className = `wg-pin cat-${place.category ?? 'other'}${at === shown.current ? ' picked' : ''}`
      pin.setAttribute('aria-label', place.name)
      pin.innerHTML = `<span class="wg-pin-mark">${glyphMarkup(place.category)}</span><span class="wg-pin-name"></span>`
      // The agent's words go in as text, never as markup.
      const name = pin.querySelector('.wg-pin-name')
      if (name) name.textContent = place.name
      pin.addEventListener('click', (event) => { event.stopPropagation(); pick.current(at) })
      new Marker({ element: pin, anchor: 'top', offset: [0, -17] }).setLngLat([place.lng, place.lat]).addTo(drawn)
      return pin
    })
    if (from) {
      const start = document.createElement('div')
      start.className = 'wg-pin-start'
      start.innerHTML = '<span class="wg-pin-start-dot"></span><span class="wg-pin-name"></span>'
      const name = start.querySelector('.wg-pin-name')
      if (name) name.textContent = from.name
      new Marker({ element: start, anchor: 'top', offset: [0, -8] }).setLngLat([from.lng, from.lat]).addTo(drawn)
    }
    return () => {
      cancelAnimationFrame(placed)
      drawn.remove()
      map.current = null
      pins.current = []
    }
    // Drawn once for the places it shows; the place in focus and the theme change it in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [places, from])

  useEffect(() => {
    if (theme.current === resolved) return
    theme.current = resolved
    // `isStyleLoaded` stays false while any of the style's pictures is missing, which OpenFreeMap's
    // sprite leaves one of: repaint whenever there is a style, and a style still on its way takes
    // the theme as it is fetched (`transformStyle`).
    try {
      if (map.current) repaint(map.current, resolved)
    } catch {
      // Not fetched yet.
    }
  }, [resolved])

  useEffect(() => {
    pins.current.forEach((pin, at) => pin.classList.toggle('picked', at === picked))
    if (shown.current === picked) return
    shown.current = picked
    declutter(pins.current, picked)
    const place = places[picked]
    if (!place || !map.current) return
    map.current.easeTo({
      center: [place.lng, place.lat],
      padding: padding(room),
      duration: quiet() ? 0 : 450,
    })
  }, [picked, places, room])

  if (broken) {
    return <div className="wg-map-canvas wg-map-broken"><p>This browser can’t draw the map. The places are below.</p></div>
  }
  // MapLibre's own stylesheet makes its box `position: relative`: it gets a box of its own, filling
  // this one, so the map's frame stays as the widget lays it out.
  return <div className="wg-map-canvas" style={{ background: groundOf(resolved) }}><div ref={box} className="wg-map-gl" /></div>
}

function padding(room: MapCanvasProps['room']) {
  // A pin's name hangs under its mark: the bottom keeps room for it.
  return { top: room.top + 44, right: room.right + 48, bottom: room.bottom + 52, left: room.left + 48 }
}
