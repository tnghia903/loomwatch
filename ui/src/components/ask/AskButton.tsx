import { MessageSquareText } from '../ui/icon'

import type { AskController } from '../../lib/ask/useAsk'
import { keys } from '../../lib/platform'

/** The header button that opens the panel, on every screen. */
export function AskButton({ ask, onToggle }: { ask: AskController; onToggle?: () => void }) {
  const working = ask.activity !== null
  return (
    <button
      type="button"
      className={`ask-button ${ask.open ? 'open' : ''} ${working ? 'working' : ''}`}
      aria-pressed={ask.open}
      aria-label={`Ask LoomWatch${working ? ` (${ask.activity})` : ''}`}
      title={`Ask LoomWatch to set up, change or run a team (${keys('⌘J')})`}
      onClick={onToggle ?? (() => ask.setOpen(!ask.open))}
    >
      <MessageSquareText size={15} aria-hidden="true" />
      <span className="ask-button-label">Ask</span>
      {working && <i className="ask-button-live" aria-hidden="true" />}
    </button>
  )
}
