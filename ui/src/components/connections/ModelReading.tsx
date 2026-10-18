import { useId, useState } from 'react'

import { announceReadingStatus, saveReadingEnabled, useReadingStatus } from '../../lib/ai/reading'
import { useKeyStatus } from '../../lib/ai/useKeyStatus'
import { SectionHead } from '../ui/SectionHead'

function money(dollars: number): string {
  return dollars < 0.01 ? 'under $0.01' : `$${dollars.toFixed(2)}`
}

/**
 * The switch for reading agents' whole setups to suggest their models (lib/ai/reading.ts): off
 * until the operator turns it on, because each reading uses a little of their OpenRouter credit.
 * State first: the switch, one line on what it gains and costs, and what it has cost so far. How
 * suggestions work and exactly what is sent are behind the heading's "?".
 */
export function ModelReading() {
  const status = useReadingStatus()
  const key = useKeyStatus()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const headingId = useId()
  const hintId = useId()
  const connected = key?.connected === true

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

  return (
    <section className="e1 lw-settings-section" aria-labelledby={headingId} aria-busy={busy}>
      <SectionHead as="h2" id={headingId} className="t-title" title="Model suggestions" explain={<>
        <div>LoomWatch suggests each agent’s model from its name and instructions, for free: the strongest for work that decides the result, a faster one for gathering, another company’s for checking.</div>
        <div><b>On</b>: an agent whose job isn’t plain is read by a small model on OpenRouter. It sees the agent’s name, instructions and Done when, and the names of its skills, tools and what it reads, never your files, your Brief or its other agents. Each agent is read once, at most {status?.dailyLimit ?? 50} a day.</div>
      </>} />
      {error && <p role="alert" className="inline-error t-body"><span className="detail">{error}</span></p>}
      {!status && !error && <p role="status" className="t-meta lw-settings-quiet">Loading…</p>}
      {status && <div className="e2 lw-settings-row">
        <label className="lw-settings-switch">
          <input type="checkbox" role="switch" checked={status.enabled} disabled={busy || (!connected && !status.enabled)} aria-describedby={hintId} onChange={(event) => void change(event.target.checked)} />
          <span className="lw-settings-switch-track" aria-hidden="true"><i /></span>
          <span className="t-body-m">Read each agent’s setup</span>
        </label>
        <span className="t-meta" id={hintId}>{connected || status.enabled ? 'Better suggestions, for under a cent of OpenRouter credit per agent.' : 'Add your OpenRouter key above first.'}</span>
        {status.readings > 0 && <span className="t-meta lw-settings-quiet">{status.readings === 1 ? '1 agent' : `${status.readings} agents`} read · {money(status.spent)}</span>}
      </div>}
    </section>
  )
}
