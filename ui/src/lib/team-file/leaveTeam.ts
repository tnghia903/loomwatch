import { useCallback, useEffect, useRef } from 'react'

import { pageIsHeld } from './inPlace'
import { goToTeam } from './teamPage'
import type { SaveState } from './useTeamDocument'

/** Changes a person made that leaving would lose, which they are asked about first. */
const ASKS: readonly SaveState[] = ['dirty', 'conflict', 'error']
/** The states a move waits through, or never makes in place. */
const UNSAVED: readonly SaveState[] = ['new', 'dirty', 'invalid', 'conflict', 'saving', 'error']

/** How a team's page moves to another team from its name menu (DocumentSwitcher). */
export interface LeaveTeam {
  /** Whether to ask about changes not saved before going: the browser would ask "Leave site?". */
  asks: () => boolean
  /** Go now: in place, or as a page load the browser asks about (`goToTeam`). */
  go: (href: string) => void
  /** Save this team, then go once it is saved; false when it couldn't be, and it stays. */
  saveThenGo: (href: string) => Promise<boolean>
  /** Read this team again from its file, dropping its changes, then go. */
  dropThenGo: (href: string) => Promise<void>
}

/**
 * Leaving a team with changes not saved, for another: keep them first, or drop them, then go. The
 * move waits for the saved or re-read team to be on screen, so nothing holds the page any more and
 * it moves in place; a save that fails stays, and the chip says why. `state` is the document's own
 * save state, not the chip's, which calls a clean but invalid file "invalid".
 */
export function useLeaveTeam(state: SaveState, save: () => Promise<boolean>, reload: () => Promise<void>): LeaveTeam {
  const leavingTo = useRef<string | null>(null)
  useEffect(() => {
    const href = leavingTo.current
    if (!href || state === 'saving') return
    leavingTo.current = null
    if (!UNSAVED.includes(state)) goToTeam(href)
  }, [state])
  const asks = useCallback(() => pageIsHeld() && ASKS.includes(state), [state])
  const saveThenGo = useCallback(async (href: string) => {
    leavingTo.current = href
    const saved = await save()
    if (!saved) leavingTo.current = null
    return saved
  }, [save])
  const dropThenGo = useCallback(async (href: string) => {
    leavingTo.current = href
    await reload()
  }, [reload])
  return { asks, go: goToTeam, saveThenGo, dropThenGo }
}
