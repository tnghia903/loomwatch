import type { Accessory } from '../quests/catalog'
import type { FigureChoice } from './figures'

/**
 * The pictures of what a figure wears (docs/QUESTS.md). Each accessory is rendered once per figure
 * from the same 3D model the bench wears (components/agents/accessoryMeshes.ts), as a layer the
 * size of the figure's still: the figure hides what is behind it, and catches its shadow. Stacked
 * over the still, the layers dress it. Made by scripts/figures.
 */
export function wearLayer(kind: FigureChoice['kind'], item: Accessory): string {
  return `/agent/wear/${kind}-${item}.webp`
}

/** The accessory worn, close up: for the wardrobe once earned, and the receipt. */
export function wearIcon(item: Accessory): string {
  return `/agent/wear/icon-${item}.webp`
}

/** The accessory alone, for its silhouette while it is locked. */
export function wearShape(item: Accessory): string {
  return `/agent/wear/shape-${item}.webp`
}

/** What shows in the chat avatar, which crops a figure to its face: the rest is below the crop. */
export const IN_CHAT: ReadonlySet<Accessory> = new Set(['chalk', 'monocle', 'shuttle'])
