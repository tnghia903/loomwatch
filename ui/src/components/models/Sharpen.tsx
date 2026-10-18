import { Focus } from 'lucide-react'
import { useId, useState } from 'react'

import { type SetupReadingState, announceReadingStatus, saveReadingEnabled, useReadingStatus } from '../../lib/ai/reading'
import { useKeyStatus } from '../../lib/ai/useKeyStatus'
import { type SuggestedAgent, needsReading, trustedKind } from '../../lib/team-file/agentSetup'

function money(dollars: number): string {
  return dollars < 0.01 ? 'under $0.01' : `$${dollars.toFixed(2)}`
}

/**
 * Along the foot of a suggestion its name and instructions don't make plain: how sure it is, as a
 * meter (half for a quick guess from its words, full once its setup is read), and Sharpen, which has
 * AI read this one agent's setup for a little OpenRouter credit (lib/ai/reading.ts). Once anything
 * has been read, "Sharpen every unclear agent on its own" turns that on for every agent. What is
 * sent and what reading has cost are the description of both.
 */
export function Sharpen({ agent, read }: { agent: SuggestedAgent; read: SetupReadingState }) {
  const status = useReadingStatus()
  const key = useKeyStatus()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const hintId = useId()
  const aboutId = useId()
  if (!status || !key?.connected || !needsReading(agent)) return null

  async function setAuto(enabled: boolean) {
    setBusy(true); setError('')
    try {
      announceReadingStatus(await saveReadingEnabled(enabled))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The setting couldn’t be changed. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const sure = read.reading ? (trustedKind(read.reading) ? 4 : 3) : 2
  const said = read.pending ? 'Reading its configuration…'
    : read.problem || (read.reading ? (sure === 4 ? 'Chosen from its configuration' : 'Read, but still not sure') : 'A quick guess')
  const spent = status.readings > 0 ? ` ${status.readings === 1 ? '1 agent' : `${status.readings} agents`} read so far, for ${money(status.spent)}.` : ''
  const about = `It sends the agent’s name, instructions and Done when, and the names of its skills, tools and what it reads, never your files or its teammates. Each agent is read once, at most ${status.dailyLimit} a day.${spent}`

  return (
    <div className="model-sharpen">
      <div className="model-sharpen-line">
        <span className="model-sureness" aria-hidden="true">{[1, 2, 3, 4].map((step) => <i key={step} className={step <= sure ? 'on' : ''} />)}</span>
        <span className={`t-meta ${read.problem ? 'inline-error' : ''}`} role="status">{said}</span>
        {read.sharpen && <button type="button" className="btn model-sharpen-button" aria-describedby={`${hintId} ${aboutId}`} title={about} onClick={read.sharpen}><Focus size={13} aria-hidden="true" />Sharpen</button>}
      </div>
      {read.sharpen && <p className="t-meta model-sharpen-hint" id={hintId}>AI will read this agent’s configuration to choose the most suitable model. It uses your OpenRouter credits, under $0.01.</p>}
      {(status.enabled || status.readings > 0) && <label className="model-sharpen-auto t-meta" title={about}>
        <input type="checkbox" checked={status.enabled} disabled={busy} aria-describedby={aboutId} onChange={(event) => void setAuto(event.target.checked)} />
        Sharpen every unclear agent on its own
      </label>}
      {error && <p role="alert" className="t-meta inline-error">{error}</p>}
      <span id={aboutId} className="visually-hidden">{about}</span>
    </div>
  )
}
