import type { PlaceCategory, WidgetPlace, WidgetStart } from './types'

/** The Earth's mean radius in metres, as the daemon (`widgets/map.rs`) and the iPhone reckon. */
const EARTH_METRES = 6_371_008.8

const radians = (degrees: number) => degrees * Math.PI / 180

/** How far apart two positions are along the Earth, in metres, as the crow flies. */
export function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const across = radians(b.lat - a.lat) / 2
  const along = radians(b.lng - a.lng) / 2
  const h = Math.sin(across) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(along) ** 2
  return 2 * EARTH_METRES * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Rounds half away from zero, as Rust's `f64::round` does: the daemon writes the same figure. */
const rounded = (value: number) => Math.sign(value) * Math.round(Math.abs(value))

/**
 * A distance as you read it: `350 m` to the nearest 10 metres under a kilometre, `1.2 km` to a
 * tenth under 10 km, then whole kilometres (`1,240 km`). Twin of `distance` in the daemon's
 * `widgets/map.rs`, which tells the agent the same figures.
 */
export function distance(metresApart: number): string {
  const tens = rounded(metresApart / 10) * 10
  if (tens < 1000) return `${Math.max(10, tens)} m`
  const tenths = rounded(metresApart / 100) / 10
  if (tenths < 10) return `${Number.isInteger(tenths) ? tenths.toFixed(0) : tenths.toFixed(1)} km`
  return `${grouped(rounded(metresApart / 1000))} km`
}

/** A whole number with commas between thousands, in every locale, as the daemon writes it. */
function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** "80 m from Galaxis": how far a place is from where you start, when the map has one. */
export function away(place: WidgetPlace, from?: WidgetStart): string | null {
  return from ? `${distance(metres(from, place))} from ${from.name}` : null
}

const CATEGORY_WORDS: Record<PlaceCategory, string | null> = {
  food: 'Restaurant',
  cafe: 'Café',
  bar: 'Bar',
  shop: 'Shop',
  hotel: 'Hotel',
  sight: 'Sight',
  park: 'Park',
  transit: 'Transit',
  other: null,
}

/** What sort of place it is, in a word: `Café`. */
export function categoryWord(category?: PlaceCategory): string | null {
  return category ? CATEGORY_WORDS[category] ?? null : null
}

/**
 * What the agent found of a place, in the order a maps app writes it: its rating (`4.8`, drawn
 * after a star), how dear it is (`$$`) and what sort of place it is (`Café`).
 */
export function facts(place: WidgetPlace): { rating: string | null; rest: string[] } {
  const rating = typeof place.rating === 'number' && place.rating >= 1 && place.rating <= 5 ? place.rating.toFixed(1) : null
  const rest: string[] = []
  if (typeof place.price === 'number' && place.price >= 1 && place.price <= 4) rest.push('$'.repeat(Math.round(place.price)))
  const word = categoryWord(place.category)
  if (word) rest.push(word)
  return { rating, rest }
}

/** The maps apps "Directions" offers, in the order it lists them. */
export type MapsApp = 'apple' | 'google'

/**
 * Directions to a place in a maps app, from wherever you are when you open it. A place with an
 * address is found by its name and address, so the app shows the place itself with its hours and
 * photos; one without is found by where the agent put it.
 */
export function directions(place: WidgetPlace, app: MapsApp): string {
  const to = place.address ? `${place.name}, ${place.address}` : `${place.lat},${place.lng}`
  if (app === 'apple') return `https://maps.apple.com/?daddr=${encodeURIComponent(to)}`
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(to)}`
}

/** A place's own website, as one to open: only a web address, never a script's. */
export function website(place: WidgetPlace): string | null {
  if (!place.link) return null
  try {
    const url = new URL(place.link)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

/** The corners of the area that holds every place and where you start, south-west then
    north-east, as `[lng, lat]`. */
export function frame(places: readonly WidgetPlace[], from?: WidgetStart): [[number, number], [number, number]] {
  const spots = from ? [...places, from] : places
  const lats = spots.map((spot) => spot.lat)
  const lngs = spots.map((spot) => spot.lng)
  return [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]]
}

/** The map LoomWatch draws with: OpenFreeMap's plain "positron" map, from OpenStreetMap, free and
    with no key, recoloured for the app's light and dark (`mapLook.ts`). The only thing the page
    loads from outside LoomWatch for an answer. */
export const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron'
