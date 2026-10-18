import { CircleHelp } from 'lucide-react'
import { Fragment, useId, useState } from 'react'

import { type SetupReadingState, announceReadingStatus, saveReadingEnabled, useReadingStatus } from '../../lib/ai/reading'
import { useKeyStatus } from '../../lib/ai/useKeyStatus'
import { type SuggestedAgent, needsReading, trustedKind } from '../../lib/team-file/agentSetup'

function money(dollars: number): string {
  return dollars < 0.01 ? 'under $0.01' : `$${dollars.toFixed(2)}`
}

/** How sure a suggestion is, one bar each: a quick guess, AI unsure, AI sure. */
const SURENESS = ['A quick guess from its configuration', 'AI read it, but isn’t sure', 'Chosen by AI from its configuration'] as const

function Bars({ lit }: { lit: number }) {
  return <>{SURENESS.map((said, index) => <i key={said} className={index < lit ? 'on' : ''} />)}</>
}

/**
 * Along the foot of a suggestion its name and instructions don't make plain: how sure it is, as a
 * three-bar meter whose key opens on hover or focus, and Let AI choose, which has AI read the
 * configuration of every such agent for a little OpenRouter credit (lib/ai/reading.ts), with a "?"
 * that says it all: what it gains, what it costs and what AI is sent. Off, the line under it says
 * what turning it on does and costs.
 */
export function AiChoice({ agent, read }: { agent: SuggestedAgent; read: SetupReadingState }) {
  const status = useReadingStatus()
  const key = useKeyStatus()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const hintId = useId()
  const aboutId = useId()
  const keyId = useId()
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

  const sure = read.reading ? (trustedKind(read.reading) ? 3 : 2) : 1
  const said = read.pending ? 'AI is reading its configuration…' : read.problem || SURENESS[sure - 1]
  const spent = status.readings > 0 ? ` So far ${status.readings === 1 ? '1 agent' : `${status.readings} agents`}, for ${money(status.spent)}.` : ''

  return (
    <div className="model-ai">
      <div className="model-ai-line">
        <span className="lw-tip">
          <span className="model-sureness" tabIndex={0} role="img" aria-label={`How sure the suggestion is: ${sure} of 3`} aria-describedby={keyId}><Bars lit={sure} /></span>
          <span className="lw-tip-bubble" role="tooltip" id={keyId}>
            <b>How sure this suggestion is</b>{' '}
            {SURENESS.map((level, index) => (
              <Fragment key={level}><span className={`model-sureness-key ${index + 1 === sure ? 'now' : ''}`}><span className="model-sureness" aria-hidden="true"><Bars lit={index + 1} /></span>{level}</span>{' '}</Fragment>
            ))}
          </span>
        </span>
        <span className={`t-meta ${read.problem ? 'inline-error' : ''}`} role="status">{said}</span>
        <span className="model-ai-toggle">
          <label className="lw-settings-switch model-ai-switch">
            <input type="checkbox" role="switch" checked={status.enabled} disabled={busy} aria-describedby={`${hintId} ${aboutId}`} onChange={(event) => void change(event.target.checked)} />
            <span className="lw-settings-switch-track" aria-hidden="true"><i /></span>
            <span className="t-meta">Let AI choose</span>
          </label>
          <span className="lw-tip lw-tip-end">
            <button type="button" className="model-ai-about" aria-label="About Let AI choose" aria-describedby={aboutId}><CircleHelp size={13} aria-hidden="true" /></button>
            <span className="lw-tip-bubble" role="tooltip" id={aboutId}>
              <span><b>A more accurate suggestion.</b> For an agent whose job its name doesn’t make plain, AI reads its configuration to choose the most suitable model, instead of a quick guess.</span>{' '}
              <span><b>Uses your OpenRouter credits.</b> Under $0.01 a reading. Each configuration is read once, at most {status.dailyLimit} a day.{spent}</span>{' '}
              <span><b>What AI is sent.</b> The agent’s name, instructions and Done when, and the names of its skills, tools and what it reads. Never your files or its teammates.</span>{' '}
              <span>One toggle for every agent.</span>
            </span>
          </span>
        </span>
      </div>
      {!status.enabled && <p className="t-meta model-ai-hint" id={hintId}>AI will read this agent’s configuration to choose the most suitable model. It uses your OpenRouter credits, under $0.01.</p>}
      {error && <p role="alert" className="t-meta inline-error">{error}</p>}
    </div>
  )
}
