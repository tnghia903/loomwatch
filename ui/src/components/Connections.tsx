import { YouTabs } from './you/YouTabs'

import { ConnectedTools } from './connections/ConnectedTools'
import { Devices } from './connections/Devices'
import { Sources } from './connections/Sources'
import { SectionHead } from './ui/SectionHead'

// Connections is a settings surface, so it is a reading column rather than a canvas:
// same tokens, e1 sections, no second visual language. The `lw-settings-*` classes in
// styles/settings.css are that standard — every section added here follows them. Notion is one of
// the tools (ADR 0070): its card also chooses the page teams' answers go under.
export default function Connections() {
  return (
    <main className="lw-settings">
      <div className="lw-settings-column">
        <YouTabs />
        <div className="lw-settings-head">
          <SectionHead page as="h1" className="t-display" title="Connections" explain="Choose how your agents’ models are paid, connect your tools and your other devices, and choose where your work belongs." />
        </div>
        <Sources />
        <ConnectedTools />
        <Devices />
      </div>
    </main>
  )
}
