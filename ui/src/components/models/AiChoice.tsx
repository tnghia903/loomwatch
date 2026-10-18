import { useId, useState } from 'react'

import { type SetupReadingState, announceReadingStatus, saveReadingEnabled, useReadingStatus } from '../../lib/ai/reading'
import { useKeyStatus } from '../../lib/ai/useKeyStatus'
import { type SuggestedAgent, needsReading, trustedKind } from '../../lib/team-file/agentSetup'

function money(dollars: number): string {
  return dollars < 0.01 ? 'under $0.01' : `$${dollars.toFixed(2)}`
}

/**
 * Along the foot of a suggestion its name and instructions don't make plain: how sure it is, as a
 * meter (half for a quick guess from its configuration, full once AI has read it), and Let AI
 * choose, which has AI read the configuration of every such agent whose model list opens, for a
 * little OpenRouter credit (lib/ai/reading.ts). Off, the line under it says what turning it on does
 * and costs; what is sent and what reading has cost are the toggle's description.
 */
export function AiChoice({ agent, read }: { agent: SuggestedAgent; read: SetupReadingState }) {
  const status = useReadingStatus()
  const key = useKeyStatus()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const hintId = useId()
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

  const sure = read.reading ? (trustedKind(read.reading) ? 4 : 3) : 2
  const said = read.pending ? 'AI is reading its configuration…'
    : read.problem || (read.reading ? (sure === 4 ? 'Chosen by AI from its configuration' : 'AI read it, but isn’t sure') : 'A quick guess from its configuration')
  const spent = status.readings > 0 ? ` ${status.readings === 1 ? '1 agent' : `${status.readings} agents`} read so far, for ${money(status.spent)}.` : ''
  const about = `One toggle for every agent whose job its name doesn’t make plain. It sends the agent’s name, instructions and Done when, and the names of its skills, tools and what it reads, never your files or its teammates. Each configuration is read once, at most ${status.dailyLimit} a day.${spent}`

  return (
    <div className="model-ai">
      <div className="model-ai-line">
        <span className="model-sureness" aria-hidden="true">{[1, 2, 3, 4].map((step) => <i key={step} className={step <= sure ? 'on' : ''} />)}</span>
        <span className={`t-meta ${read.problem ? 'inline-error' : ''}`} role="status">{said}</span>
        <label className="lw-settings-switch model-ai-switch" title={about}>
          <input type="checkbox" role="switch" checked={status.enabled} disabled={busy} aria-describedby={`${hintId} ${aboutId}`} onChange={(event) => void change(event.target.checked)} />
          <span className="lw-settings-switch-track" aria-hidden="true"><i /></span>
          <span className="t-meta">Let AI choose</span>
        </label>
      </div>
      {!status.enabled && <p className="t-meta model-ai-hint" id={hintId}>AI will read this agent’s configuration to choose the most suitable model. It uses your OpenRouter credits, under $0.01.</p>}
      {error && <p role="alert" className="t-meta inline-error">{error}</p>}
      <span id={aboutId} className="visually-hidden">{about}</span>
    </div>
  )
}
