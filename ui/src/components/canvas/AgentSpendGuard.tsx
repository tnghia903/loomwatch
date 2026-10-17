import { useId, useState } from 'react'

import { dollarField, dollars, typedDollars } from '../../lib/runs/spend'

/**
 * The agent's own guard on what one run may spend on it (ADR 0068), beside the model that sets the
 * price. It is there to stop an agent that runs away, so it is empty unless you set it. Past it the
 * agent waits, and you add more or stop it there; the rest of the team carries on.
 */
export function AgentSpendGuard({ perRun, readOnly, onChange }: { perRun: number | null; readOnly: boolean; onChange: (perRun: number | null) => void }) {
  const id = useId()
  const shown = perRun === null ? '' : dollarField(perRun)
  const [text, setText] = useState(shown)
  // A change made elsewhere (undo, the file on disk) shows here, unless you are typing.
  const [seen, setSeen] = useState(shown)
  if (shown !== seen) { setSeen(shown); setText(shown) }
  const commit = () => {
    // Passing through the field without typing leaves the guard exactly as the file has it.
    if (text === shown) return
    const next = typedDollars(text)
    setText(next === null ? '' : dollarField(next))
    if (next !== perRun) onChange(next)
  }
  return (
    <div className="field agent-spend">
      <label className="t-meta" htmlFor={id}>Stop it past, each run</label>
      <span className="agent-spend-input">
        <span aria-hidden="true">$</span>
        <input id={id} className="input" type="number" inputMode="decimal" min="0.01" step="any" placeholder="no limit" value={text} disabled={readOnly}
          onChange={(event) => setText(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') commit() }} />
      </span>
      <span className="hint t-meta">{perRun === null
        ? 'Empty: it spends from the team’s limit like the others.'
        : `Past ${dollars(perRun)} in a run, it waits for you to add more or to stop it.`}</span>
    </div>
  )
}
