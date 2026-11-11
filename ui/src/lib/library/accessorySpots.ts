import type { Accessory } from '../quests/catalog'
import { posed, type FigureChoice, type FigureState } from './figures'

/**
 * The pictures of what a figure wears (docs/QUESTS.md). Each accessory is rendered once per build in
 * Blender, as a layer the size of the figure's still: the figure hides what is
 * behind it. Stacked over the still, the layers dress it.
 */
export function wearLayer(kind: FigureChoice['kind'], item: Accessory, color: FigureChoice['color'], state: FigureState = 'ready'): string {
  return IN_COLOR.has(item) ? `/agent/wear/${kind}-${item}-${color}${posed(state)}.webp` : `/agent/wear/${kind}-${item}${posed(state)}.webp`
}

/** What is made in the figure's own colour: a layer per colour. Nothing is today: every item keeps its
    own colour, none of them a state's (gold, blue, red, green). */
export const IN_COLOR: ReadonlySet<Accessory> = new Set([])

/** The accessory worn, close up: for the wardrobe once earned, and the receipt. */
export function wearIcon(item: Accessory): string {
  return `/agent/wear/icon-${item}.webp`
}

/** The accessory alone, for its silhouette while it is locked. */
export function wearShape(item: Accessory): string {
  return `/agent/wear/shape-${item}.webp`
}

/** What shows in the chat avatar, which crops a figure to its face: the rest is below the crop. */
export const IN_CHAT: ReadonlySet<Accessory> = new Set(['beret', 'bow'])
