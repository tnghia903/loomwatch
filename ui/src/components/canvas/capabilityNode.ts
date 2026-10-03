import type { Node } from '@xyflow/react'

import type { CapabilityKind } from '../../lib/composer-layout/types'

/**
 * A skill, tool or knowledge source placed on the canvas. Both surfaces draw it with the same
 * Build card; a run adds no facts of its own to a capability, because planned wiring never
 * claims a capability ran (TNG-122 §5) — the receipts for that live in the evidence panel.
 */
export interface CapabilityNodeData extends Record<string, unknown> {
  kind: CapabilityKind
  name: string
  source: string
  /** For a folder or file the operator chose (ADR 0042): where it is. */
  path?: string
  /** How many agents reach it. Zero reads as "placed but not wired to anything yet". */
  wiredTo: number
  readOnly: boolean
  onRemove: () => void
}

export type CapabilityNode = Node<CapabilityNodeData, 'capability'>
