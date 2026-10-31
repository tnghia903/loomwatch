import { YouTabs } from './YouTabs'

import { AboutYou } from './AboutYou'
import { SectionHead } from '../ui/SectionHead'

// About you (`/you`, ADR 0074) is a settings surface like Connections: a reading column on the
// `lw-settings-*` standard in styles/settings.css.
export default function AboutYouPage() {
  return (
    <main className="lw-settings">
      <div className="lw-settings-column">
        <YouTabs />
        <div className="lw-settings-head">
          <SectionHead page as="h1" className="t-display" title="About you" explain="Tell your agents who you are, so their answers fit you." />
        </div>
        <AboutYou />
      </div>
    </main>
  )
}
