import { IN_CHAT, wearIcon, wearLayer, wearShape } from '../../lib/library/accessorySpots'
import type { FigureKind } from '../../lib/library/figures'
import { ACCESSORIES, type Accessory } from '../../lib/quests/catalog'

/**
 * What a figure wears from the wardrobe (lib/quests/catalog.ts), drawn over its still: one layer
 * per accessory, the same size as the still, so whatever crops or scales the still (the chat
 * avatar's crop, a card) does the same to these. The layers are rendered from the 3D bench's own
 * accessories (accessoryMeshes.ts), so the pictures and the bench agree. `headOnly` keeps only
 * what shows at the size of a face, for the smallest pictures.
 */
export function WornOverlay({ kind, wear, headOnly = false, className }: { kind: FigureKind; wear: readonly Accessory[]; headOnly?: boolean; className?: string }) {
  const shown = ACCESSORIES.filter((item) => wear.includes(item) && (!headOnly || IN_CHAT.has(item)))
  if (shown.length === 0) return null
  return (
    <span className={className ?? 'worn-overlay'} aria-hidden="true">
      {shown.map((item) => <img key={item} src={wearLayer(kind, item)} alt="" decoding="async" />)}
    </span>
  )
}

/** One accessory, close up as it is worn; while locked, its silhouette alone. */
export function AccessoryIcon({ item, locked = false, className }: { item: Accessory; locked?: boolean; className?: string }) {
  return <img className={className ?? 'accessory-icon'} src={locked ? wearShape(item) : wearIcon(item)} alt="" width={96} height={96} loading="lazy" decoding="async" />
}
