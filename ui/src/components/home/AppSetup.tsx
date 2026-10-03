import { Check, Copy, ExternalLink } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'

import { APP_SETUP_GUIDES, appSetupState, checkSignature, type AppSetupGuide, type AppSetupState } from '../../lib/appSetup'
import { fetchHarnesses, fetchHarnessModels, type DetectedHarness } from '../../lib/harnesses'
import { ChipDot, type ChipState } from '../ui/glyphs'

/** How often the panel asks the daemon what is installed. A PATH scan, never an app start. */
export const SETUP_POLL_MS = 4000
/**
 * How soon the panel may check an app again on its own when the daemon holds no verdict for it:
 * after a check that recorded nothing, or once the daemon's 10-minute record has lapsed.
 */
export const SETUP_RECHECK_MS = 5 * 60 * 1000

export interface AppSetupProps {
  /** The app-wide list; the panel keeps its own fresher copy while it polls. */
  harnesses: readonly DetectedHarness[]
  /** Something changed that the rest of LoomWatch should hear about: an app became ready, or failed. */
  onChanged: () => void
  onHide: () => void
}

const STATUS: Record<AppSetupState['kind'], { chip: ChipState; text: string }> = {
  missing: { chip: 'new', text: 'Not installed' },
  checking: { chip: 'saving', text: 'Checking…' },
  found: { chip: 'new', text: 'Not checked yet' },
  no_bridge: { chip: 'failed', text: 'Can’t be used' },
  signed_out: { chip: 'incomplete', text: 'Not signed in' },
  failed: { chip: 'failed', text: 'Can’t start' },
  restart: { chip: 'incomplete', text: 'Restart LoomWatch' },
  ready: { chip: 'saved', text: 'Ready' },
}

function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }
  return (
    <span className="hs-cmd">
      <code className="t-mono-sm">{command}</code>
      <button type="button" className="iconbtn" onClick={() => void copy()} aria-label={copied ? 'Copied' : `Copy ${command}`} title={copied ? 'Copied' : 'Copy'}>
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
    </span>
  )
}

/**
 * A card's guide: the full setup guide for an app the panel recommends, or just a name for
 * another app already on this computer (Gemini, Hermes, OpenClaw), whose status and checks
 * belong here too, but whose install the panel does not walk through.
 */
type CardGuide = Pick<AppSetupGuide, 'id' | 'name'> & Partial<AppSetupGuide>

function AppCard({ guide, state, connector, onCheck }: { guide: CardGuide; state: AppSetupState; connector: boolean; onCheck: () => void }) {
  const status = STATUS[state.kind]
  const checkAgain = <button type="button" className="btn" onClick={onCheck}>Check again</button>
  return (
    <li className={`hs-app ${state.kind}`} aria-label={`${guide.name}: ${status.text}`}>
      <div className="hs-app-head">
        <span className="hs-app-name">{guide.name}{guide.badge && <em>{guide.badge}</em>}</span>
        <span className="hs-app-status t-meta"><ChipDot state={status.chip} size={10} />{status.text}</span>
      </div>
      {guide.account && <p className="hs-app-account">{guide.account}</p>}

      {state.kind === 'missing' && guide.install && (
        <ol className="hs-steps">
          <li><span>Install it. Paste this into Terminal and press Return:</span><CommandLine command={guide.install} /></li>
          {guide.signIn
            ? <li><span>Then sign in. This opens your browser:</span><CommandLine command={guide.signIn} /></li>
            : <li><span>That’s all. LoomWatch notices it here on its own.</span></li>}
        </ol>
      )}
      {state.kind === 'checking' && (
        <p className="hs-note t-meta">
          {connector
            ? `Making sure ${guide.name} can start. The first check can take a minute while LoomWatch downloads ${guide.name}’s connector.`
            : `Making sure ${guide.name} can start…`}
        </p>
      )}
      {state.kind === 'found' && (
        <div className="hs-fix">
          <span>{guide.name} is on this computer. Check that it can start and is signed in:</span>
          <span className="hs-fix-acts"><button type="button" className="btn" onClick={onCheck}>Check {guide.name}</button></span>
        </div>
      )}
      {state.kind === 'signed_out' && (
        <div className="hs-fix">
          {guide.signIn ? <><span>Sign in. This opens your browser:</span><CommandLine command={guide.signIn} /></> : <span>{state.reason}</span>}
          <span className="hs-fix-acts">{checkAgain}<span className="t-meta">LoomWatch also checks again when you come back to this window.</span></span>
        </div>
      )}
      {state.kind === 'restart' && (
        <div className="hs-fix">
          <span>
            {guide.name} was installed after LoomWatch started, so LoomWatch can’t start it yet. Stop LoomWatch (press Ctrl-C in
            its Terminal window, or run <code className="t-mono-sm">./loomwatch stop</code>), then open a new Terminal window and run <code className="t-mono-sm">./loomwatch</code> again.
          </span>
        </div>
      )}
      {(state.kind === 'failed' || state.kind === 'no_bridge') && (
        <div className="hs-fix">
          <span role="alert" className="hs-problem">{state.reason}</span>
          {state.kind === 'failed' && state.detail && (
            <details className="hs-detail"><summary className="t-meta">What {guide.name} said</summary><pre className="t-mono-sm">{state.detail}</pre></details>
          )}
          <span className="hs-fix-acts">
            {state.kind === 'failed' && checkAgain}
            {guide.docs && <a className="link" href={guide.docs} target="_blank" rel="noreferrer">{guide.name} install help<ExternalLink size={12} aria-hidden="true" /></a>}
          </span>
        </div>
      )}
      {state.kind === 'ready' && guide.optionalSignIn && (
        <p className="hs-note t-meta">For more models, sign in to a provider: <code className="t-mono-sm">{guide.optionalSignIn}</code></p>
      )}
    </li>
  )
}

/**
 * "Set up an AI app": what someone with no working AI app does next, on Home (ADR 0045).
 *
 * Each app's card walks from install to sign-in to ready without a button press: the panel asks
 * the daemon what is installed every few seconds and whenever the window regains focus, and checks
 * an app — sign-in included — as soon as it appears. That check starts the app once, so it runs
 * once per install, not on every poll.
 */
export function AppSetup({ harnesses, onChanged, onHide }: AppSetupProps) {
  const [report, setReport] = useState<readonly DetectedHarness[]>(harnesses)
  const [checking, setChecking] = useState<ReadonlySet<string>>(() => new Set())
  const attempted = useRef(new Map<string, { signature: string; at: number; sawVerdict: boolean }>())
  const titleId = useId()

  // A newer app-wide list replaces the panel's copy (React's "adjust state when a prop changes").
  const [given, setGiven] = useState(harnesses)
  if (given !== harnesses) {
    setGiven(harnesses)
    setReport(harnesses)
  }

  const refresh = useCallback(async () => {
    try {
      setReport((await fetchHarnesses()).harnesses ?? [])
    } catch {
      // The footer reports an unreachable daemon; the panel keeps what it last saw.
    }
  }, [])

  // Polls only while the page is visible; coming back to it (window focus, or the tab showing
  // again after the person was in Terminal) asks at once.
  useEffect(() => {
    const visible = () => document.visibilityState === 'visible'
    const tick = () => { if (visible()) void refresh() }
    const back = () => { void refresh() }
    const shown = () => { if (visible()) void refresh() }
    const timer = window.setInterval(tick, SETUP_POLL_MS)
    window.addEventListener('focus', back)
    document.addEventListener('visibilitychange', shown)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', back)
      document.removeEventListener('visibilitychange', shown)
    }
  }, [refresh])

  const check = useCallback(async (harness: DetectedHarness) => {
    attempted.current.set(harness.id, { signature: checkSignature(harness), at: Date.now(), sawVerdict: false })
    setChecking((current) => new Set(current).add(harness.id))
    try {
      // Sign-in and a real handshake: the daemon records the verdict on the harness list.
      await fetchHarnessModels(harness.id).catch(() => undefined)
      await refresh()
    } finally {
      setChecking((current) => {
        const next = new Set(current)
        next.delete(harness.id)
        return next
      })
    }
  }, [refresh])

  const cards: { guide: CardGuide; harness: DetectedHarness | undefined }[] = [
    ...APP_SETUP_GUIDES.map((guide) => ({ guide, harness: report.find((candidate) => candidate.id === guide.id) })),
    ...report
      .filter((harness) => !APP_SETUP_GUIDES.some((guide) => guide.id === harness.id))
      .map((harness) => ({ guide: { id: harness.id, name: harness.name }, harness })),
  ]

  // Check an app the daemon holds no verdict for: as soon as it appears, and again when a verdict
  // the panel saw is gone (LoomWatch restarted, or its 10-minute record lapsed). A check that itself
  // left no verdict (the daemon was busy, say) is not repeated on every poll; it waits for
  // SETUP_RECHECK_MS, or for "Check".
  useEffect(() => {
    for (const harness of report) {
      if (harness.acpAvailable === false || checking.has(harness.id)) continue
      const last = attempted.current.get(harness.id)
      const sameInstall = last?.signature === checkSignature(harness)
      if (harness.health !== undefined) {
        if (last && sameInstall) last.sawVerdict = true
        continue
      }
      if (last && sameInstall && !last.sawVerdict && Date.now() - last.at < SETUP_RECHECK_MS) continue
      void check(harness)
    }
  }, [report, checking, check])

  const states = cards.map(({ guide, harness }) => ({
    guide,
    harness,
    state: appSetupState(harness, harness ? checking.has(harness.id) : false),
  }))
  const ready = states.filter(({ state }) => state.kind === 'ready')

  // Tell the rest of LoomWatch when a verdict changes, so the footer, New team and the Library
  // stop offering a signed-out app and start offering a ready one. Not on the first render.
  const verdicts = report.map((harness) => `${harness.id}:${harness.health ?? '-'}:${harness.healthCause ?? '-'}:${harness.needsRestart ? 'restart' : '-'}`).join(' ')
  const previousVerdicts = useRef(verdicts)
  useEffect(() => {
    if (previousVerdicts.current === verdicts) return
    previousVerdicts.current = verdicts
    onChanged()
  }, [verdicts, onChanged])

  return (
    <section className="home-setup" data-tour="app-setup" aria-labelledby={titleId}>
      <header className="home-setup-head">
        <div>
          <h2 id={titleId}>{ready.length > 0 ? 'Your AI app is ready' : 'Set up an AI app'}</h2>
          <p>
            {ready.length > 0
              ? `${ready.map(({ guide }) => guide.name).join(' and ')} can run your agents now. Press New team to make your first team. You can add another app below at any time.`
              : 'Your agents run inside an AI app on this computer, signed in as you. Install one of these. You only need one, and this page notices on its own when it’s ready.'}
          </p>
        </div>
        {/* No second "create a team" here: New team, above, is that action's one control (ADR 0043). */}
        <span className="home-setup-acts">
          <button type="button" className="link" onClick={onHide}>{ready.length > 0 ? 'Done' : 'Hide'}</button>
        </span>
      </header>
      <ul className="hs-apps">
        {states.map(({ guide, harness, state }) => (
          <AppCard
            key={guide.id}
            guide={guide}
            state={state}
            connector={harness?.spawn.cmd === 'npx'}
            onCheck={() => { if (harness) void check(harness) }}
          />
        ))}
      </ul>
      <p className="home-setup-foot t-meta">Terminal is in Applications › Utilities. LoomWatch also works with Gemini CLI, Hermes and OpenClaw if you already use them.</p>
    </section>
  )
}
