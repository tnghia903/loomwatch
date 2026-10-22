// An answer of the pinned agent being dragged out of the island into another app (ADR 0083,
// decision 9): while it is, a drop back onto the island is not something new for the slot.
let tearing = false

export const isTearing = (): boolean => tearing

export function setTearing(on: boolean): void {
  tearing = on
}
