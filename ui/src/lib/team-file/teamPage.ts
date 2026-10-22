import { useEffect, useState } from 'react'

import { markMovedInPlace, pageIsHeld } from './inPlace'
import { handOverTeam, readTeam } from './useTeamDocument'

export { teamHref } from './teamHref'

const OPEN = 'loomwatch:open-team'

/**
 * Go to a team's page. While a team page (or Home) is showing, the move is made in place: the
 * page frame, the team rail and everything the app has loaded stay, and only the team's own part
 * starts fresh, as it would on a page load. Anywhere else, or while leaving would lose changes not
 * saved, it is a page load, and the browser asks first, as it always has.
 */
export function goToTeam(href: string) {
  if (!pageIsHeld() && !window.dispatchEvent(new CustomEvent(OPEN, { detail: href, cancelable: true }))) return
  window.location.assign(href)
}

/** What the team page shows: a new `key` each time it moves to another team (or Home). */
export interface TeamPage {
  key: number
  runId: string | null
}

const runIn = (search: string) => new URLSearchParams(search).get('run')

/**
 * The team page's address, followed in place: `goToTeam`, and Back and Forward. The next team is
 * read before anything changes, so it shows complete at once and the one before stays until then.
 */
export function useTeamPage(): TeamPage {
  const [page, setPage] = useState<TeamPage>(() => ({ key: 0, runId: runIn(window.location.search) }))
  useEffect(() => {
    let latest = 0
    // The address on screen, to put back when Back or Forward would lose changes not saved.
    let shown = window.location.href
    const show = async (href: string, push: boolean) => {
      const asked = ++latest
      const path = new URL(href, window.location.href).searchParams.get('path')
      // A team that can't be read opens as on any load, which says what went wrong.
      const read = path ? await readTeam(path).catch(() => null) : null
      if (asked !== latest) return
      if (path) handOverTeam(path, read)
      if (push) window.history.pushState(null, '', href)
      shown = window.location.href
      markMovedInPlace()
      setPage((current) => ({ key: current.key + 1, runId: runIn(window.location.search) }))
    }
    const open = (event: Event) => {
      event.preventDefault()
      void show((event as CustomEvent<string>).detail, true)
    }
    const moved = () => {
      if (pageIsHeld()) {
        // The team and its address stay; the move goes as a page load, so the browser asks first.
        const target = window.location.href
        window.history.pushState(null, '', shown)
        window.location.assign(target)
        return
      }
      void show(window.location.href, false)
    }
    window.addEventListener(OPEN, open)
    window.addEventListener('popstate', moved)
    return () => {
      window.removeEventListener(OPEN, open)
      window.removeEventListener('popstate', moved)
    }
  }, [])
  return page
}
