import { useSyncExternalStore } from 'react'

import type { TeamRailProps } from './TeamRail'

/**
 * The team rail the page frame draws (`App.tsx`). The team on screen sets it and clears it as it
 * goes, so the rail stays, with its place in the list and the keyboard on it, while teams change
 * in place beside it.
 */
let shown: TeamRailProps | null = null
const listeners = new Set<() => void>()

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function showTeamRail(rail: TeamRailProps | null) {
  shown = rail
  for (const listener of listeners) listener()
}

export function useShownTeamRail(): TeamRailProps | null {
  return useSyncExternalStore(subscribe, () => shown)
}

/** Whether the frame has a rail to draw, which changes only as a team opens or the page leaves teams. */
export function useTeamRailShown(): boolean {
  return useSyncExternalStore(subscribe, () => shown !== null)
}
