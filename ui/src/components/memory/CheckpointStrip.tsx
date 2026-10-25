import { useState } from 'react'

import type { Checkpoint } from '../../lib/memory/client'
import { InlineMarkdown } from '../ui/Markdown'

/**
 * The strip on a stopped or failed run: what the work had reached, and one action.
 *
 * **The label is "Start a new run from this checkpoint", verbatim, and never "Resume".**
 * `docs/TEAM_MEMORY.md` §3 channel 4 is explicit about it, and the reason is not tone: nothing
 * here reattaches to the stopped run's processes, and nothing reconciles the side effects it had
 * already caused. "Resume" would claim both. It becomes available when scheduler state and
 * side-effect reconciliation exist — which is a different change.
 *
 * The checkpoint is shown **in plain words** rather than as a record: the operator is deciding
 * whether to spend a run on it, and "Done / Next" is the only part of it that answers that.
 *
 * Two labels, because there are two writers and they are not interchangeable. A stage's own
 * checkpoint says what it would do next. A `coordinator` row is what LoomWatch assembled from the
 * archive after the run died, so its `next` is empty and the strip says so instead of leaving a
 * gap that reads as "nothing left to do".
 */
export interface CheckpointStripProps {
  /** The attempt number: the run's number among this team's runs. */
  attempt: number
  /** The newest checkpoint per agent, in the order the run reached them. */
  checkpoints: readonly Checkpoint[]
  /** Names for the agent ids, so the strip says "Writer" and not `writer`. */
  names: ReadonlyMap<string, string>
  onStart: (checkpointId: string) => Promise<void>
  onDismiss: () => void
}

export function CheckpointStrip({ attempt, checkpoints, names, onStart, onDismiss }: CheckpointStripProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  if (checkpoints.length === 0) return null
  // The last stage to reach a boundary is the one the work stopped at, so it leads.
  const latest = checkpoints[checkpoints.length - 1]
  const who = names.get(latest.agentId) ?? latest.agentId
  return (
    <div className="rt-strip t-meta" role="status" data-testid="checkpoint-strip">
      <span style={{ flex: 1, minWidth: 0, display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3, overflow: 'hidden' }}>
        <b>Run {String(attempt).padStart(2, '0')} stopped at {who}</b>
        {' · '}
        {/* A checkpoint LoomWatch put together from the run's record (a stop or a restart) has no
            "next" of its own: the new run picks up from what was done. */}
        {latest.source === 'coordinator'
          ? <>LoomWatch kept the work up to here{plain(latest.done) ? <>: <InlineMarkdown>{plain(latest.done)}</InlineMarkdown></> : null}. A new run carries on from it.</>
          : <>Done: <InlineMarkdown>{plain(latest.done)}</InlineMarkdown>. Next: <InlineMarkdown>{plain(latest.next)}</InlineMarkdown>.</>}
        {latest.blockers ? <> Blocked on: <InlineMarkdown>{plain(latest.blockers)}</InlineMarkdown>.</> : null}
      </span>
      <button
        type="button"
        className="btn"
        disabled={busy !== null}
        onClick={() => {
          setBusy(latest.id)
          setFailed(null)
          onStart(latest.id)
            .catch((caught: unknown) => setFailed(caught instanceof Error ? caught.message : String(caught)))
            .finally(() => setBusy(null))
        }}
      >
        {busy === latest.id ? 'Starting…' : 'Start a new run from this checkpoint'}
      </button>
      <button type="button" className="btn" onClick={onDismiss} disabled={busy !== null}>Not now</button>
      {failed && <span role="alert" style={{ color: 'var(--color-alert)' }}>{failed}</span>}
    </div>
  )
}

/** One line of a checkpoint field, whole and with its Markdown: the strip is a sentence, not the
 * record, and its three lines cut it. */
function plain(value: string): string {
  const first = value.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? ''
  // The strip's sentence ends each field itself: "Done: drafted." not "Done: drafted..".
  return first.replace(/[.!?。]+$/, '')
}
