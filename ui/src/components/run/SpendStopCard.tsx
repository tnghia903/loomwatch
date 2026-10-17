import { Coins } from 'lucide-react'
import { useState } from 'react'

import { useRevealOnArrival } from '../../lib/chat/follow'
import { answerSpend, type RunRecord, type SpendDecision, type SpendStop } from '../../lib/runs/client'
import { dollars, stopActions, stopSentence } from '../../lib/runs/spend'

interface SpendStopCardProps {
  run: Pick<RunRecord, 'runId' | 'spendStops'>
  /** In the team's chat, under the piece of work it pauses, rather than floating over the screen. */
  inline?: boolean
  /** An answer was chosen here: the team's chat follows its newest work again. */
  onDecide?: () => void
  /** The run as the daemon has it after the answer. */
  onRun?: (run: RunRecord) => void
}

/**
 * The run used what it may spend, or one agent used its own guard (ADR 0068). The agents wait, and
 * nothing is spent while they do: add money and carry on, or finish with what the team has.
 */
export function SpendStopCard({ run, inline = false, onDecide, onRun }: SpendStopCardProps) {
  // Answered here, before the next poll of the run takes them off the record.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const open = (run.spendStops ?? []).filter((stop) => !answered.has(stop.id))
  if (open.length === 0 && !error) return null
  return (
    <section className={`permission-prompt spend-stop${inline ? ' inline' : ' e2'}`} aria-label="Waiting for you: spending" role="region">
      {open.map((stop) => (
        <Stop key={stop.id} runId={run.runId} stop={stop} onDecide={onDecide} onRun={onRun}
          // A refused answer leaves the stop as it was; one that is gone leaves with the next poll.
          onAnswered={(failure) => { if (!failure) setAnswered((current) => new Set(current).add(stop.id)); setError(failure) }} />
      ))}
      {error && <p className="permission-error" role="alert">{error}</p>}
    </section>
  )
}

function Stop({ runId, stop, onDecide, onRun, onAnswered }: {
  runId: string
  stop: SpendStop
  onDecide?: () => void
  onRun?: (run: RunRecord) => void
  onAnswered: (failure: string | null) => void
}) {
  const element = useRevealOnArrival<HTMLElement>()
  const [busy, setBusy] = useState(false)
  const words = stopActions(stop)
  const answer = async (decision: SpendDecision) => {
    onDecide?.()
    setBusy(true)
    let failure: string | null = null
    try {
      const next = await answerSpend(runId, stop.id, decision)
      onRun?.(next)
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught)
    }
    setBusy(false)
    onAnswered(failure)
  }
  // A call's cost is only known once it is made, so the calls under way when the limit is reached,
  // one for each agent at work, can take the run a little over.
  const over = stop.spentUsd > stop.limitUsd ? ` (calls already under way took it ${dollars(stop.spentUsd - stop.limitUsd)} over)` : ''
  return (
    <article ref={element} className="permission-ask" aria-live="polite">
      <header>
        <Coins size={18} aria-hidden="true" />
        <strong>{stopSentence(stop)}</strong>
      </header>
      <p className="permission-note">
        Spent {dollars(stop.spentUsd)}{over}. {stop.agent ? `${stop.name || stop.agent} waits` : 'The agents wait'}, and nothing more is spent until you answer.
      </p>
      <div className="permission-acts">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void answer('add')}>{words.add}</button>
        <button type="button" className="btn" disabled={busy} onClick={() => void answer('finish')}
          title={stop.agent ? `${stop.name || stop.agent} ends its turn with what it wrote; the rest of the team carries on` : 'The run ends now, with the last words an agent wrote as its answer. Its checkpoint is kept.'}>
          {words.finish}
        </button>
      </div>
    </article>
  )
}
