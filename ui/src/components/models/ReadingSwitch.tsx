import { useId, useState } from 'react'

import { announceReadingStatus, saveReadingEnabled, useReadingStatus } from '../../lib/ai/reading'
import { useKeyStatus } from '../../lib/ai/useKeyStatus'
import { type SuggestedAgent, needsReading } from '../../lib/team-file/agentSetup'

function money(dollars: number): string {
  return dollars < 0.01 ? 'under $0.01' : `$${dollars.toFixed(2)}`
}

/**
 * The switch for reading agents' whole setups (lib/ai/reading.ts), along the foot of the suggestion
 * it improves: its name says what it gains, the line under it what it does and costs, or, once
 * on, that a reading is under way or why it failed (`note`). It shows for an agent whose name and
 * instructions don't place it, once a key is set, and is off until turned on. It is the one switch
 * for every agent; what is sent and what reading has cost are its description.
 */
export function ReadingSwitch({ agent, note }: { agent: SuggestedAgent; note?: string }) {
  const status = useReadingStatus()
  const key = useKeyStatus()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const nameId = useId()
  const noteId = useId()
  const aboutId = useId()
  if (!status || !key?.connected || !needsReading(agent)) return null

  async function change(enabled: boolean) {
    setBusy(true); setError('')
    try {
      announceReadingStatus(await saveReadingEnabled(enabled))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The setting couldn’t be changed. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const spent = status.readings > 0 ? ` ${status.readings === 1 ? '1 agent' : `${status.readings} agents`} read so far, for ${money(status.spent)}.` : ''
  const about = `It sends the agent’s name, instructions and Done when, and the names of its skills, tools and what it reads, never your files or its teammates. Each agent is read once, at most ${status.dailyLimit} a day. One switch for every agent.${spent}`

  return (
    <div className="model-reading">
      <label className="lw-settings-switch model-reading-switch" title={about}>
        <input type="checkbox" role="switch" checked={status.enabled} disabled={busy} aria-labelledby={nameId} aria-describedby={`${noteId} ${aboutId}`} onChange={(event) => void change(event.target.checked)} />
        <span className="lw-settings-switch-track" aria-hidden="true"><i /></span>
        <span className="model-reading-text">
          <span className="t-body" id={nameId}>More accurate suggestion</span>
          <span className={`t-meta ${error ? 'inline-error' : ''}`} id={noteId} role={error ? 'alert' : 'status'}>{error || note || 'AI reads its whole setup. Uses your OpenRouter credit: under $0.01 an agent.'}</span>
        </span>
      </label>
      <span id={aboutId} className="visually-hidden">{about}</span>
    </div>
  )
}
