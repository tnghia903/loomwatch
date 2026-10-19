import { ArrowLeft } from 'lucide-react'

import { AboutYou } from './AboutYou'

// About you (`/you`, ADR 0074) is a settings surface like Connections: a reading column on the
// `lw-settings-*` standard in styles/settings.css.
export default function AboutYouPage() {
  return (
    <main className="lw-settings">
      <div className="lw-settings-column">
        <a href="/agents" className="link lw-settings-back"><ArrowLeft size={14} aria-hidden="true" /> Back to My agents</a>
        <div className="lw-settings-head">
          <h1 className="t-display">About you</h1>
          <p className="t-body">Tell your agents who you are, so their answers fit you.</p>
        </div>
        <AboutYou />
      </div>
    </main>
  )
}
