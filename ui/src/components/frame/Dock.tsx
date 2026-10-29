import { useState } from 'react'

import { useNeedsYou } from '../../lib/story/useNeedsYou'
import { Icon, type IconName } from '../ui/icon'
import { countUse, LABEL_USES, placeOf, readUses, toggleAsk, type Place } from './frameStore'

const PLACES: readonly { place: Place; label: string; icon: IconName; href?: string }[] = [
  { place: 'home', label: 'Home', icon: 'home', href: '/' },
  { place: 'projects', label: 'Projects', icon: 'projects', href: '/projects' },
  { place: 'agents', label: 'Agents', icon: 'agent', href: '/agents' },
  { place: 'skills', label: 'Skills', icon: 'skills', href: '/skills' },
  { place: 'quests', label: 'Quests', icon: 'quests', href: '/quests' },
]
const FOOT: readonly { place: Place; label: string; icon: IconName; href?: string }[] = [
  { place: 'ask', label: 'Ask', icon: 'ask' },
  { place: 'you', label: 'You', icon: 'you', href: '/you' },
]

/**
 * The dock: the same seven places down the side of every screen (round 3). The place you are in
 * has the gold stitch; Home carries the count of what needs you. Each name shows under its icon
 * until it has been used a few times, then only on hover and to screen readers.
 */
export function Dock() {
  const { tickets } = useNeedsYou()
  const [uses] = useState(readUses)
  const here = placeOf(window.location.pathname, window.location.search)
  const needs = tickets.length

  const item = ({ place, label, icon, href }: (typeof PLACES)[number]) => {
    const learned = (uses[place] ?? 0) >= LABEL_USES
    const said = place === 'home' && needs > 0 ? `${label}, ${needs} need${needs === 1 ? 's' : ''} you` : label
    const body = (
      <>
        <span className="lw-dock-icon">
          <Icon name={icon} size={22} />
          {place === 'home' && needs > 0 && <span className="lw-dock-count" aria-hidden="true">{needs > 99 ? '99+' : needs}</span>}
        </span>
        <span className="lw-dock-label" aria-hidden="true" hidden={learned || undefined}>{label}</span>
      </>
    )
    return (
      <li key={place}>
        {href
          ? <a className="lw-dock-place" href={href} aria-label={said} title={said} aria-current={here === place ? 'page' : undefined} onClick={() => countUse(place)}>{body}</a>
          : <button type="button" className="lw-dock-place" aria-label={said} title={`${said} (⌘J)`} onClick={() => { countUse(place); toggleAsk() }}>{body}</button>}
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
