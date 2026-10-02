import { Component, type ErrorInfo, type ReactNode } from 'react'

import { describeSystem, fetchAbout, issueUrl, type AboutLoomWatch } from '../../lib/feedback/report'
import { ChipDot } from './glyphs'

interface State {
  error: Error | null
  /** Which LoomWatch crashed, for the report link; `null` until the server answers. */
  about: AboutLoomWatch | null
}

/**
 * The last line of defence: a render error anywhere below used to unmount the whole app and leave
 * a blank page with no way out but the address bar. This says what happened in plain words and
 * offers the two ways back, plus a prefilled report. Saved teams and runs are on disk and in the
 * archive, so no button can lose them.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, about: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('LoomWatch hit an unexpected error', error, info.componentStack)
    fetchAbout().then((about) => this.setState({ about }), () => { /* The report says the server did not answer. */ })
  }

  render() {
    const { error, about } = this.state
    if (!error) return this.props.children
    return (
      <div className="lw-modal-scrim">
        <div role="alertdialog" aria-modal="true" aria-label="Something went wrong" className="e2 lw-dialog">
          <div style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'flex-start' }}>
            <ChipDot state="invalid" />
            <span>
              <div className="t-title">Something went wrong on this screen.</div>
              <div className="t-meta" style={{ color: 'var(--color-ink-3)' }}>
                Your saved teams and runs are safe. Go back to your teams, or reload to try again.
              </div>
            </span>
          </div>
          <details className="t-meta" style={{ color: 'var(--color-ink-3)' }}>
            <summary>Details</summary>
            <pre className="code t-mono" style={{ whiteSpace: 'pre-wrap' }}>{error.message}</pre>
          </details>
          <div style={{ display: 'flex', gap: 'var(--sp-3)' }}>
            <button type="button" className="btn btn-primary" onClick={() => window.location.assign('/')}>Back to your teams</button>
            <button type="button" className="btn" onClick={() => window.location.reload()}>Reload</button>
            {/* The app below is gone, so this is a plain link rather than the feedback dialog. */}
            <a className="btn" style={{ textDecoration: 'none' }} href={issueUrl('problem', describeSystem(about, null, { error: error.message }), `Error: ${error.message}`)} target="_blank" rel="noreferrer">Report this problem</a>
          </div>
        </div>
      </div>
    )
  }
}
