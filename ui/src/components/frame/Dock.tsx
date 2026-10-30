import { useEffect, useState, useSyncExternalStore, type FocusEvent, type MouseEvent } from 'react'

import { useNeedsYou } from '../../lib/story/useNeedsYou'
import { Icon, type IconName } from '../ui/icon'
import { keys } from '../../lib/platform'
import { MOVED_EVENT } from '../../lib/team-file/inPlace'
import { goToTeam } from '../../lib/team-file/teamPage'
import { countUse, LABEL_USES, placeOf, readUses, toggleAsk, useAskShown, type Place } from './frameStore'

const PLACES: readonly { place: Place; label: string; icon: IconName; href?: string }[] = [
  { place: 'home', label: 'Home', icon: 'home', href: '/' },
  { place: 'projects', label: 'Projects', icon: 'projects', href: '/projects' },
  { place: 'agents', label: 'My agents', icon: 'agent', href: '/agents' },
  { place: 'skills', label: 'Skills', icon: 'skills', href: '/skills' },
  { place: 'quests', label: 'Quests', icon: 'quests', href: '/quests' },
]
const FOOT: readonly { place: Place; label: string; icon: IconName; href?: string }[] = [
  { place: 'ask', label: 'Ask', icon: 'ask' },
  { place: 'you', label: 'You', icon: 'you', href: '/you' },
]

// The page moves in place between Home, Projects and a team (teamPage.ts), so the dock follows the
// address rather than reading it once.
const subscribePlace = (changed: () => void) => {
  window.addEventListener('popstate', changed)
  window.addEventListener(MOVED_EVENT, changed)
  return () => { window.removeEventListener('popstate', changed); window.removeEventListener(MOVED_EVENT, changed) }
}
const placeHere = () => placeOf(window.location.pathname, window.location.search)

/** Home and Projects open in place from a team's page, as another team does; a click that asks for
    a new tab gets one. */
function follow(place: Place, href: string, event: MouseEvent) {
  countUse(place)
  if (place !== 'home' && place !== 'projects') return
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  goToTeam(href)
}

/**
 * The dock: the same seven places down the side of every screen (round 3). The place you are in
 * has the gold stitch; Home carries the count of what needs you. Each name shows under its icon
 * until it has been used a few times, then only on hover and to screen readers. ⌘J is Ask's key on
 * every screen.
 */
export function Dock() {
  const { tickets } = useNeedsYou()
  const [uses] = useState(readUses)
  const asking = useAskShown()
  // The place keyboard focus is on shows its name again, where a hover's title never shows.
  const [focused, setFocused] = useState<Place | null>(null)
  const here = useSyncExternalStore(subscribePlace, placeHere, () => 'home' as Place)
  const needs = tickets.length
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        toggleAsk()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const item = ({ place, label, icon, href }: (typeof PLACES)[number]) => {
    const learned = (uses[place] ?? 0) >= LABEL_USES
    const said = place === 'home' && needs > 0 ? `${label}, ${needs} need${needs === 1 ? 's' : ''} you`
      : place === 'ask' ? `Ask LoomWatch${asking.here ? '' : ', on Home'}${asking.activity ? ` (${asking.activity})` : ''}`
      : label
    const body = (
      <>
        <span className="lw-dock-icon">
          <Icon name={icon} size={22} />
          {place === 'home' && needs > 0 && <span className="lw-dock-count" aria-hidden="true">{needs > 99 ? '99+' : needs}</span>}
          {place === 'ask' && asking.activity && <i className="lw-dock-live" aria-hidden="true" />}
        </span>
        <span className="lw-dock-label" aria-hidden="true" hidden={(learned && focused !== place) || undefined}>{label}</span>
        {here === place && <svg className="lw-dock-stitch" viewBox="0 0 4 28" aria-hidden="true"><path d="M2 2V26" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray="4 4" fill="none" /></svg>}
      </>
    )
    const focus = {
      onFocus: (event: FocusEvent<HTMLElement>) => { if (event.currentTarget.matches(':focus-visible')) setFocused(place) },
      onBlur: () => setFocused((current) => (current === place ? null : current)),
    }
    return (
      <li key={place}>
        {href
          ? <a className="lw-dock-place" href={href} aria-label={said} title={said} aria-current={here === place ? 'page' : undefined} data-tour={place === 'home' ? 'dock-home' : undefined} onClick={(event) => follow(place, href, event)} {...focus}>{body}</a>
          : <button type="button" className="lw-dock-place" aria-label={said} aria-pressed={asking.open} title={`${said} (${keys('⌘J')})`} onClick={() => { countUse(place); toggleAsk() }} {...focus}>{body}</button>}
      </li>
    )
  }

  return (
    <nav className="lw-dock" aria-label="LoomWatch">
      <ul className="lw-dock-places">{PLACES.map(item)}</ul>
      <ul className="lw-dock-places lw-dock-foot">{FOOT.map(item)}</ul>
    </nav>
  )
}
