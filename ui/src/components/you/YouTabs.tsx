import { useState } from 'react'

import { openFeedback } from '../../lib/feedback/report'
import { useTheme } from '../../lib/theme'
import { startTour } from '../../lib/tour/store'
import { countUse, LABEL_USES, readUses } from '../frame/frameStore'
import { Icon, type IconName } from '../ui/icon'

const TABS: readonly { href: string; label: string; icon: IconName; use: string }[] = [
  { href: '/you', label: 'About you', icon: 'you', use: 'you:about' },
  { href: '/connections', label: 'Connections', icon: 'plug', use: 'you:connections' },
  { href: '/usage', label: 'Usage', icon: 'usage', use: 'you:usage' },
]

/**
 * You's row (round 3): About you, Connections and Usage as one set of tabs, then the look, the
 * getting started guide and feedback, which every screen reaches from here. Each tab says its name
 * beside its icon until it has been used as many times as the dock's places are.
 */
export function YouTabs() {
  const { resolved, toggle } = useTheme()
  const [uses] = useState(readUses)
  const here = window.location.pathname
  const look = resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
  return (
    <nav className="lw-you-tabs" aria-label="You">
      <span className="lw-you-tabset">
        {TABS.map((tab) => (
          <a key={tab.href} className="lw-you-tab" href={tab.href} aria-label={tab.label} title={tab.label} aria-current={here === tab.href ? 'page' : undefined} onClick={() => countUse(tab.use)}>
            <Icon name={tab.icon} size={19} />
            <span className="lw-you-tab-label" aria-hidden="true" hidden={(uses[tab.use] ?? 0) >= LABEL_USES || undefined}>{tab.label}</span>
          </a>
        ))}
      </span>
      <span className="lw-you-acts">
        <button type="button" className="iconbtn" onClick={toggle} aria-label={look} title={look}><Icon name={resolved === 'dark' ? 'sun' : 'moon'} size={17} /></button>
        {/* The guide's first steps are on Home, so it starts there. */}
        <button type="button" className="iconbtn" onClick={() => { startTour(); window.location.assign('/') }} aria-label="Getting started guide" title="Getting started guide"><Icon name="compass" size={17} /></button>
        <button type="button" className="iconbtn" onClick={() => openFeedback({ screen: 'you' })} aria-label="Send feedback" title="Send feedback"><Icon name="megaphone" size={17} /></button>
      </span>
    </nav>
  )
}
