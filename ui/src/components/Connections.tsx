import { ArrowLeft } from './ui/icon'

import { ConnectedTools } from './connections/ConnectedTools'
import { Sources } from './connections/Sources'

// Connections is a settings surface, so it is a reading column rather than a canvas:
// same tokens, e1 sections, no second visual language. The `lw-settings-*` classes in
// styles/settings.css are that standard — every section added here follows them. Notion is one of
// the tools (ADR 0070): its card also chooses the page teams' answers go under.
export default function Connections() {
  return (
    <main className="lw-settings">
      <div className="lw-settings-column">
        <a href="/" className="link lw-settings-back"><ArrowLeft size={14} aria-hidden="true" /> Back to Home</a>
        <div className="lw-settings-head">
          <h1 className="t-display">Connections</h1>
          <p className="t-body">Choose how your agents’ models are paid, connect your tools, and choose where your work belongs.</p>
        </div>
        <Sources />
        <ConnectedTools />
      </div>
    </main>
  )
}
