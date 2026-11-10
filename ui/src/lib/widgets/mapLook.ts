/**
 * The map's look, in the app's light and dark: OpenFreeMap's plain "positron" map recoloured as a
 * phone's maps app draws a city, warm ground and white streets by day, slate ground and grey
 * streets by night, green parks, blue water and quiet buildings. One map, repainted when the theme
 * changes, so nothing is loaded again.
 */

export type MapTheme = 'light' | 'dark'

interface Look {
  ground: string
  park: string
  wood: string
  water: string
  homes: string
  building: string
  buildingEdge: string
  path: string
  street: string
  streetEdge: string
  main: string
  mainEdge: string
  motorway: string
  motorwayEdge: string
  rail: string
  border: string
  label: string
  placeLabel: string
  waterLabel: string
  halo: string
}

const LOOKS: Record<MapTheme, Look> = {
  light: {
    ground: '#f6f4ef', park: '#d3eac8', wood: '#cde5c1', water: '#aad3f2', homes: '#f1eee8',
    building: '#e9e5dd', buildingEdge: '#ddd7cd', path: '#fbfaf7', street: '#ffffff', streetEdge: '#e2ddd3',
    main: '#ffffff', mainEdge: '#d9d3c8', motorway: '#ffe7a3', motorwayEdge: '#e9c868', rail: '#d6d1c8',
    border: '#b9b4ab', label: '#5c5c60', placeLabel: '#3a3a3c', waterLabel: '#4a7fb5', halo: '#ffffff',
  },
  dark: {
    ground: '#2e3338', park: '#2d4a40', wood: '#2b4539', water: '#1c3446', homes: '#31363b',
    building: '#3a4047', buildingEdge: '#444b52', path: '#3b4148', street: '#474e55', streetEdge: '#2a2e33',
    main: '#565e66', mainEdge: '#2a2e33', motorway: '#6e6553', motorwayEdge: '#3a372f', rail: '#4a5057',
    border: '#5d646b', label: '#c3c8cd', placeLabel: '#e6e8eb', waterLabel: '#7fa7c9', halo: '#2e3338',
  },
}

/** A layer's colours in `theme`, by its id and kind, as `paint` property → colour. A layer the look
    doesn't name keeps its own. */
export function layerPaint(id: string, type: string, theme: MapTheme): Record<string, string> {
  const look = LOOKS[theme]
  if (type === 'background') return { 'background-color': look.ground }
  if (type === 'symbol') {
    const color = id.startsWith('water') ? look.waterLabel : id.startsWith('label_') ? look.placeLabel : look.label
    return { 'text-color': color, 'text-halo-color': look.halo }
  }
  if (type === 'fill') {
    if (id === 'park') return { 'fill-color': look.park }
    if (id === 'landcover_wood') return { 'fill-color': look.wood }
    if (id === 'water') return { 'fill-color': look.water }
    if (id === 'landuse_residential') return { 'fill-color': look.homes }
    if (id === 'building') return { 'fill-color': look.building, 'fill-outline-color': look.buildingEdge }
    if (id.startsWith('landcover_ice') || id.startsWith('landcover_glacier')) return { 'fill-color': look.ground }
    if (id.startsWith('road_area') || id === 'aeroway-area') return { 'fill-color': look.street }
    return {}
  }
  if (type === 'line') {
    if (id === 'waterway') return { 'line-color': look.water }
    if (id.startsWith('boundary')) return { 'line-color': look.border }
    if (id.startsWith('railway')) return { 'line-color': id.endsWith('dashline') ? look.ground : look.rail }
    if (id === 'highway_path') return { 'line-color': look.path }
    if (id === 'highway_minor' || id === 'road_pier' || id.startsWith('aeroway')) return { 'line-color': look.street }
    if (id.includes('motorway')) return { 'line-color': id.includes('casing') ? look.motorwayEdge : look.motorway }
    if (id.includes('casing')) return { 'line-color': look.mainEdge }
    if (id.startsWith('highway')) return { 'line-color': look.main }
    return {}
  }
  return {}
}

/** A map style with every layer the look names in `theme`'s colours, as MapLibre is given it
    before it draws anything, so a dark app never shows a light map first. */
export function recolored<Style extends { layers: { id: string; type: string; paint?: unknown }[] }>(style: Style, theme: MapTheme): Style {
  return {
    ...style,
    layers: style.layers.map((layer) => {
      const paint = layerPaint(layer.id, layer.type, theme)
      return Object.keys(paint).length === 0 ? layer : { ...layer, paint: { ...(layer.paint as object | undefined), ...paint } }
    }),
  }
}

/** The theme's ground, for the map's box before its first tiles. */
export function groundOf(theme: MapTheme): string {
  return LOOKS[theme].ground
}
