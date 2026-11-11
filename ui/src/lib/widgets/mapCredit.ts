/**
 * Fold the maps' credit in `box` into its (i), which opens it again. MapLibre's compact credit
 * opens when the map first draws; folded from the start, it doesn't stand over the map.
 */
export function foldCredit(box: ParentNode | null | undefined) {
  box?.querySelector('.maplibregl-ctrl-attrib.maplibregl-compact')?.classList.remove('maplibregl-compact-show')
}
