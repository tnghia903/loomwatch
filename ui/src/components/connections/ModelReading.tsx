import { useId, useState } from 'react'

import { announceReadingStatus, saveReadingEnabled, useReadingStatus } from '../../lib/ai/reading'
import { useKeyStatus } from '../../lib/ai/useKeyStatus'

function money(dollars: number): string {
  return dollars < 0.01 ? 'less than $0.01' : `$${dollars.toFixed(2)}`
}

/**
 * The switch for reading agents' whole setups to suggest their models (lib/ai/reading.ts): off
 * until the operator turns it on, because each reading uses a little of their OpenRouter credit.
 * Says what it gains, what it costs, what is sent and what it has cost so far.
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
      <h2 id={headingId} className="t-title">Model suggestions</h2>
      <p className="t-body">When you choose an agent’s model, LoomWatch suggests one that fits its job: the strongest model for work that decides the result, a faster one for gathering facts for another agent, and another company’s model for checking work. It works this out from the agent’s name and instructions, for free, on this computer.</p>
      {error && <p role="alert" className="inline-error t-body"><span className="detail">{error}</span></p>}
      {!status && !error && <p role="status" className="t-meta lw-settings-quiet">Loading…</p>}
      {status && <div className="e2 lw-settings-row">
        <label className="lw-settings-switch">
          <input type="checkbox" role="switch" checked={status.enabled} disabled={busy || (!connected && !status.enabled)} aria-describedby={hintId} onChange={(event) => void change(event.target.checked)} />
          <span className="lw-settings-switch-track" aria-hidden="true"><i /></span>
          <span className="t-body-m">Read each agent’s whole setup for better suggestions</span>
        </label>
        <span className="t-meta" id={hintId}>
          Suggestions get more accurate, and this uses your OpenRouter credit. For an agent whose name and instructions don’t say its job plainly, LoomWatch has a small AI model on OpenRouter read its instructions, skills and tools. Each agent it reads costs a tiny amount, far less than a cent. An agent is read once, and again only after you change it.
        </span>
        {!connected && !status.enabled && <span className="t-meta">Add your OpenRouter key above to turn this on.</span>}
        <span className="t-meta lw-settings-quiet">What is sent: the agent’s name, instructions and Done when, and the names of its skills, tools and what it reads. Never your files, your team’s Brief or its other agents. At most {status.dailyLimit} agents a day.</span>
        {status.readings > 0 && <span className="t-meta">{status.readings === 1 ? '1 agent read' : `${status.readings} agents read`} so far, for {money(status.spent)}.</span>}
      </div>}
    </section>
  )
}
