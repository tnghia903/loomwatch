import { useCallback, useState } from 'react'
import { CheckCircle2, CircleAlert, FileWarning } from 'lucide-react'

import { fetchInstructions, RunApiError } from '../../lib/runs/client'
import type { RequiredSkillReceipt } from '../../lib/watch/events'

type Verdict =
  | { kind: 'match'; text: string; chars: number }
  | { kind: 'changed'; text: string; chars: number; sha256: string }
  | { kind: 'gone'; message: string }

/**
 * The instructions a run put in an agent's opening prompt, read back on request.
 *
 * A run records the *fingerprint* of what it supplied, never the bytes, so this reads the prepared
 * copy the run wrote into the agent's workspace and compares the two. That comparison is the whole
 * point: a hash proves nothing to a person, and showing today's file as though it were the run's
 * evidence would be a claim the archive cannot support.
 *
 * What it establishes is that these instructions were *supplied*. Whether the agent followed them
 * is a separate question this component must never appear to answer.
 */
export function SuppliedInstructions({ receipt }: { receipt: RequiredSkillReceipt }) {
  const [open, setOpen] = useState(false)
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const read = useCallback(() => {
    if (open) { setOpen(false); return }
    setOpen(true)
    if (verdict || loading) return
    setLoading(true)
    setError(null)
    fetchInstructions(receipt.path).then(
      (file) => {
        setVerdict(file.sha256 === receipt.sha256
          ? { kind: 'match', text: file.content, chars: file.chars }
          : { kind: 'changed', text: file.content, chars: file.chars, sha256: file.sha256 })
      },
      (caught: unknown) => {
        // A 404 is not a failure of this feature: the prepared copy is rebuilt every run, so an
        // older run's instructions can simply be gone. Say that, rather than reporting an error.
        if (caught instanceof RunApiError && caught.status === 404) setVerdict({ kind: 'gone', message: caught.message })
        else setError(caught instanceof Error ? caught.message : String(caught))
      },
    ).finally(() => setLoading(false))
  }, [open, verdict, loading, receipt.path, receipt.sha256])

  return (
    <div className="supplied-instructions">
      <button type="button" className="delivery-link" aria-expanded={open} onClick={read}>
        {open ? 'Hide the instructions' : `Read the ${receipt.chars.toLocaleString()} characters that were supplied`}
      </button>
      {open && (
        <div className="supplied-body">
          {loading && <p className="t-meta">Reading the prepared copy…</p>}
          {error && <p className="supplied-verdict changed"><CircleAlert size={14} aria-hidden="true" /><span>Could not read them back: {error}</span></p>}
          {verdict?.kind === 'match' && (
            <>
              <p className="supplied-verdict match">
                <CheckCircle2 size={14} aria-hidden="true" />
                <span>This is what ran. The prepared copy still matches the fingerprint this run recorded.</span>
              </p>
              <pre className="supplied-text t-mono-sm">{verdict.text}</pre>
            </>
          )}
          {verdict?.kind === 'changed' && (
            <>
              <p className="supplied-verdict changed">
                <CircleAlert size={14} aria-hidden="true" />
                <span>Changed since this run. The file now reads <code>{verdict.sha256.slice(0, 12)}…</code>, so this is a later version — shown for reference, not as this run’s evidence.</span>
              </p>
              <pre className="supplied-text t-mono-sm">{verdict.text}</pre>
            </>
          )}
          {verdict?.kind === 'gone' && (
            <p className="supplied-verdict changed">
              <FileWarning size={14} aria-hidden="true" />
              <span>Not on disk any more. The prepared copy is rebuilt on every run, so only the fingerprint survives from this one.</span>
            </p>
          )}
        </div>
      )}
    </div>
  )
}
