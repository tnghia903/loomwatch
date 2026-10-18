import { useState } from 'react'

import { announceReadingStatus, saveReadingEnabled, useReadingStatus } from '../../lib/ai/reading'
import { useKeyStatus } from '../../lib/ai/useKeyStatus'
import { type SuggestedAgent, needsReading } from '../../lib/team-file/agentSetup'

const DISMISSED = 'loomwatch:reading-offer-dismissed'

function wasDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED) === '1'
  } catch {
    return false
  }
}

/**
 * Offered under a suggestion the free reading isn't sure of, while reading setups is off: what
 * turning it on gains, what it costs, and the switch itself. "Not now" hides it in every picker;
 * Connections still has the switch.
 */
export function ReadingOffer({ agent }: { agent: SuggestedAgent }) {
  const status = useReadingStatus()
  const key = useKeyStatus()
  const [dismissed, setDismissed] = useState(wasDismissed)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!status || status.enabled || !key?.connected || dismissed || !needsReading(agent)) return null

  async function turnOn() {
    setBusy(true); setError('')
    try {
      announceReadingStatus(await saveReadingEnabled(true))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Reading couldn’t be turned on. Try again.')
    } finally {
      setBusy(false)
    }
  }

  function notNow() {
    setDismissed(true)
    try {
      window.localStorage.setItem(DISMISSED, '1')
    } catch { /* it shows again next time */ }
  }

  return (
    <div className="e2 model-reading-offer" role="group" aria-label="Better model suggestions">
      <p className="t-meta">This agent’s name and instructions don’t say its job plainly, so this suggestion may not fit. LoomWatch can read its whole setup, its instructions, skills and tools, to suggest a model that fits better.</p>
      <p className="t-meta lw-settings-quiet">Each agent it reads uses a tiny amount of your OpenRouter credit, far less than a cent. An agent is read once, and again only after you change it.</p>
      {error && <p role="alert" className="t-meta inline-error">{error}</p>}
      <div className="lw-settings-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void turnOn()}>{busy ? 'Turning on…' : 'Read setups for better suggestions'}</button>
        <button type="button" className="link" onClick={notNow}>Not now</button>
      </div>
    </div>
  )
}
