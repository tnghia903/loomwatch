import { openFeedback } from '../../lib/feedback/report'
import { useTheme } from '../../lib/theme'
import { startTour } from '../../lib/tour/store'
import { Icon, type IconName } from '../ui/icon'

const TABS: readonly { href: string; label: string; icon: IconName }[] = [
  { href: '/you', label: 'About you', icon: 'you' },
  { href: '/connections', label: 'Connections', icon: 'plug' },
  { href: '/usage', label: 'Usage', icon: 'usage' },
]

/**
 * You's row (round 3): About you, Connections and Usage as one set of tabs, then the look, the
 * getting started guide and feedback, which every screen reaches from here.
 */
export function YouTabs() {
  const { resolved, toggle } = useTheme()
  const here = window.location.pathname
  const look = resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
  return (
    <nav className="lw-you-tabs" aria-label="You">
      <span className="lw-you-tabset">
        {TABS.map((tab) => (
          <a key={tab.href} className="lw-you-tab" href={tab.href} aria-label={tab.label} title={tab.label} aria-current={here === tab.href ? 'page' : undefined}>
            <Icon name={tab.icon} size={19} />
          </a>
        ))}
      </span>
      <span className="lw-you-acts">
        <button type="button" className="iconbtn" onClick={toggle} aria-label={look} title={look}><Icon name={resolved === 'dark' ? 'sun' : 'moon'} size={17} /></button>
        <button type="button" className="iconbtn" onClick={startTour} aria-label="Getting started guide" title="Getting started guide"><Icon name="help" size={17} /></button>
        <button type="button" className="iconbtn" onClick={() => openFeedback({ screen: 'home' })} aria-label="Send feedback" title="Send feedback"><Icon name="megaphone" size={17} /></button>
      </span>
    </nav>
  )
}
