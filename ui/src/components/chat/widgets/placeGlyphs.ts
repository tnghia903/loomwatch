import { ICON_PATHS, type IconName } from '../../ui/icon/paths'
import type { PlaceCategory } from '../../../lib/widgets/types'

/**
 * The mark for each sort of place, from LoomWatch's own icons (`ui/icon/paths.ts`), as a maps app
 * marks its pins: a fork and knife, a cup, a glass, a bag, a bed, a camera, a tree, a train, or a
 * pin. The iPhone draws the same icons (`PlaceKind.icon`). Drawn by LoomWatch, never by the agent,
 * so a pin's mark is only ever one of these.
 */
export const PLACE_ICONS: Record<PlaceCategory, IconName> = {
  food: 'fork-knife',
  cafe: 'cup',
  bar: 'glass',
  shop: 'bag',
  hotel: 'bed',
  sight: 'camera',
  park: 'tree',
  transit: 'train',
  other: 'map-pin',
}

export function placeIcon(category: PlaceCategory | undefined): IconName {
  return PLACE_ICONS[category ?? 'other'] ?? 'map-pin'
}

/** A place's mark as SVG markup, for a pin the map draws outside React. Only LoomWatch's own paths
    go in it, never the agent's words. */
export function glyphMarkup(category: PlaceCategory | undefined): string {
  return `<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON_PATHS[placeIcon(category)]}"/></svg>`
}
