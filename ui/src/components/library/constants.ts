// docs/CANVAS_SPEC.md §4.5 step 1: dataTransfer.setData('application/loomwatch-source', …)
export const LIBRARY_DRAG_MIME = 'application/loomwatch-source'
/** Repositions an immutable observed-evidence card; it never creates planned config. */
export const EVIDENCE_DRAG_MIME = 'application/loomwatch-evidence'
/** A planned skill / tool / knowledge card. It never creates an agent, so it needs its own type. */
export const CAPABILITY_DRAG_MIME = 'application/loomwatch-capability'
/**
 * A connected service, such as Notion (ADR 0050). It is not a card yet: dropping it asks which page,
 * and the page becomes the card.
 */
export const CONNECTION_DRAG_MIME = 'application/loomwatch-connection'
