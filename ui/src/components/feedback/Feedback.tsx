import { Check, Copy, ExternalLink } from 'lucide-react'
import { useEffect, useId, useState } from 'react'

import type { DetectedHarness } from '../../lib/harnesses'
import {
  describeSystem,
  fetchAbout,
  FEEDBACK_EVENT,
  issueUrl,
  type AboutLoomWatch,
  type FeedbackContext,
  type FeedbackKind,
} from '../../lib/feedback/report'

const KINDS: { kind: FeedbackKind; label: string; hint: string }[] = [
  { kind: 'problem', label: 'Something went wrong', hint: 'An error, or something that did not do what you expected' },
  { kind: 'idea', label: 'An idea or suggestion', hint: 'Something that would make LoomWatch better for you' },
]

/**
 * The app's one feedback dialog, opened from anywhere by `openFeedback()`: Home's Feedback
 * button, the team menu, and the command palette.
 */
export function Feedback({ harnesses }: { harnesses: readonly DetectedHarness[] }) {
  const [context, setContext] = useState<FeedbackContext | null>(null)
  useEffect(() => {
    const open = (event: Event) => setContext((event as CustomEvent<FeedbackContext | undefined>).detail ?? {})
    window.addEventListener(FEEDBACK_EVENT, open)
    return () => window.removeEventListener(FEEDBACK_EVENT, open)
  }, [])
  if (!context) return null
  return <FeedbackDialog harnesses={harnesses} context={context} onClose={() => setContext(null)} />
}

export interface FeedbackDialogProps {
  harnesses: readonly DetectedHarness[]
  context: FeedbackContext
  onClose: () => void
}

/**
 * Says what a report contains before anything leaves the computer, then hands over to GitHub in a
 * new tab, where the operator writes and submits it. LoomWatch posts nothing itself. A tester
 * without GitHub access can copy the same details instead.
 */
export function FeedbackDialog({ harnesses, context, onClose }: FeedbackDialogProps) {
  const titleId = useId()
  const [kind, setKind] = useState<FeedbackKind>('problem')
  const [about, setAbout] = useState<AboutLoomWatch | null>(null)
  const [checking, setChecking] = useState(true)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    fetchAbout(controller.signal)
      .then((found) => { if (!controller.signal.aborted) setAbout(found) })
      .catch(() => { /* The report says the server did not answer, which is itself worth knowing. */ })
      .finally(() => { if (!controller.signal.aborted) setChecking(false) })
    return () => controller.abort()
  }, [])

  const details = describeSystem(checking ? null : about, harnesses, context)
  const href = issueUrl(kind, details)

  async function copy() {
    try {
      await navigator.clipboard.writeText(details)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="lw-scrim dim" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="pop e2 lw-feedback"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}
      >
        <h2 id={titleId}>Send feedback</h2>
        <p>Your report opens as a new issue on LoomWatch’s GitHub, where you can add screenshots and follow what happens to it.</p>
        {/* The New team dialog's option cards, so both choices look and behave alike. */}
        <fieldset className="nt-templates">
          <legend className="visually-hidden">What would you like to send?</legend>
          {KINDS.map((option, index) => (
            <label key={option.kind} className={`nt-option ${kind === option.kind ? 'on' : ''}`}>
              <input type="radio" name="feedback-kind" value={option.kind} checked={kind === option.kind} onChange={() => setKind(option.kind)} autoFocus={index === 0} />
              <span className="nt-check" aria-hidden="true">{kind === option.kind && <Check size={12} />}</span>
              <span className="nt-body"><span className="nt-title">{option.label}</span><span className="nt-desc">{option.hint}</span></span>
            </label>
          ))}
        </fieldset>
        <div className="fb-details">
          <span className="nt-label">Added to your report</span>
          <pre className="code t-mono-sm" aria-busy={checking}>{details}</pre>
          <p>Nothing from your teams, files or runs. You can edit all of it on GitHub before you submit.</p>
        </div>
        <p className="fb-note">You need a GitHub account with access to LoomWatch. No access? Copy the details and send them, with what happened, to the person who invited you.</p>
        <div className="fb-acts">
          <button type="button" className="btn" onClick={() => void copy()}>
            {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{copied ? 'Copied' : 'Copy details'}
          </button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          {/* A link, not window.open: browsers never block it, and the tab is the operator's. It
              closes the dialog only after the click has navigated: a link removed during its own
              click would not open at all. */}
          <a className="btn btn-primary" href={href} target="_blank" rel="noreferrer" onClick={() => window.setTimeout(onClose, 0)}>
            Continue on GitHub<ExternalLink size={14} aria-hidden="true" />
          </a>
        </div>
      </div>
    </div>
  )
}
