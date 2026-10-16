import { Check, Copy, ExternalLink } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'

import { APP_SETUP_GUIDES, appSetupState, checkSignature, installCommand, type AppSetupGuide, type AppSetupState } from '../../lib/appSetup'
import { listNames } from '../../lib/format'
import { fetchHarnesses, fetchHarnessModels, installHarness, prepareHarness, sendSignInCode, signInHarness, type DetectedHarness, type HarnessReport } from '../../lib/harnesses'
import { isWindows } from '../../lib/platform'
import { ChipDot, type ChipState } from '../ui/glyphs'

/** How often the panel asks the daemon what is installed. A PATH scan, never an app start. */
export const SETUP_POLL_MS = 4000
/** How often while something the panel started is under way: a download, a sign-in, an install. */
export const SETUP_BUSY_POLL_MS = 1000
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
  /** No team exists yet, so a ready app's next step is the first one. */
  firstTeam?: boolean
}

const STATUS: Record<AppSetupState['kind'], { chip: ChipState; text: string }> = {
  missing: { chip: 'new', text: 'Not installed' },
  checking: { chip: 'saving', text: 'Checking…' },
  found: { chip: 'new', text: 'Not checked yet' },
  no_bridge: { chip: 'failed', text: 'Can’t be used' },
  signed_out: { chip: 'incomplete', text: 'Not signed in' },
  needs_key: { chip: 'incomplete', text: 'Needs an API key' },
  failed: { chip: 'failed', text: 'Can’t start' },
  restart: { chip: 'incomplete', text: 'Restart LoomWatch' },
  preparing: { chip: 'saving', text: 'Getting ready…' },
  connector_failed: { chip: 'failed', text: 'Couldn’t get ready' },
  installing: { chip: 'saving', text: 'Installing…' },
  signing_in: { chip: 'saving', text: 'Signing in…' },
  setup_failed: { chip: 'failed', text: 'Didn’t finish' },
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

interface CardActions {
  onCheck: () => void
  /** Install the app's connector, which carries the app (Claude, Codex). */
  onPrepare: () => void
  onInstall: () => void
  onSignIn: () => void
  /** Hand a running sign-in the code its page showed; rejects with the daemon's reason. */
  onCode: (code: string) => Promise<void>
}

/** The Terminal way, kept for anyone who prefers it, folded away under the button. */
function ByHand({ children }: { children: ReactNode }) {
  return (
    <details className="hs-detail">
      <summary className="t-meta">Or do it in Terminal</summary>
      {children}
    </details>
  )
}

function SignInCode({ name, onCode }: { name: string; onCode: (code: string) => Promise<void> }) {
  const [code, setCode] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  async function send() {
    setSending(true)
    setProblem(null)
    try {
      await onCode(code)
      setCode('')
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setSending(false)
    }
  }
  return (
    <form className="hs-code" onSubmit={(event) => { event.preventDefault(); void send() }}>
      <label className="t-meta" htmlFor={`code-${name}`}>At the end, the page shows a code. Paste it here:</label>
      <span className="hs-fix-acts">
        <input id={`code-${name}`} className="input" value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" spellCheck={false} disabled={sending} />
        <button type="submit" className="btn btn-primary" disabled={sending || code.trim() === ''}>Finish signing in</button>
      </span>
      {problem && <span role="alert" className="hs-problem">{problem}</span>}
    </form>
  )
}

function AppCard({ guide, state, connector, actions }: { guide: CardGuide; state: AppSetupState; connector: boolean; actions: CardActions }) {
  const { onCheck, onPrepare, onInstall, onSignIn, onCode } = actions
  const status = STATUS[state.kind]
  // The launcher as it is typed here: `loomwatch` on Windows, where the installer puts it on PATH.
  const launcher = isWindows() ? 'loomwatch' : './loomwatch'
  const checkAgain = <button type="button" className="btn" onClick={onCheck}>Check again</button>
  const terminalSteps = guide.install && (
    <ol className="hs-steps">
      <li><span>Install it. Paste this into Terminal and press Return:</span><CommandLine command={guide.install} /></li>
      {guide.signIn
        ? <li><span>Then sign in. This opens your browser:</span><CommandLine command={guide.signIn} /></li>
        : <li><span>That’s all. LoomWatch notices it here on its own.</span></li>}
    </ol>
  )
  return (
    <li className={`hs-app ${state.kind}`} aria-label={`${guide.name}: ${status.text}`}>
      <div className="hs-app-head">
        <span className="hs-app-name">{guide.name}{guide.badge && <em>{guide.badge}</em>}</span>
        <span className="hs-app-status t-meta"><ChipDot state={status.chip} size={10} />{status.text}</span>
      </div>
      {guide.account && <p className="hs-app-account">{guide.account}</p>}

      {state.kind === 'missing' && guide.setup && (
        <div className="hs-fix">
          <span>
            {guide.setup === 'connector'
              ? `LoomWatch downloads ${guide.name} into its own folder (${guide.size}, once).${guide.signIn ? ' Then you sign in.' : ''}`
              : `LoomWatch runs ${guide.name}’s own installer (${guide.size}, once).`}
          </span>
          <span className="hs-fix-acts">
            <button type="button" className="btn btn-primary" onClick={guide.setup === 'connector' ? onPrepare : onInstall}>
              {guide.setup === 'connector' ? `Set up ${guide.name}` : `Install ${guide.name}`}
            </button>
          </span>
          {terminalSteps && <ByHand>{terminalSteps}</ByHand>}
        </div>
      )}
      {state.kind === 'missing' && !guide.setup && terminalSteps}
      {state.kind === 'installing' && (
        <p className="hs-note t-meta">Running {guide.name}’s installer. This page notices on its own when it’s done.</p>
      )}
      {state.kind === 'signing_in' && (
        <div className="hs-fix">
          <span>Your browser opened {guide.name}’s sign-in page. Sign in there.{state.needsCode ? '' : ' This page notices on its own when you’re done.'}</span>
          {state.needsCode && <SignInCode name={guide.id} onCode={onCode} />}
          {state.url && (
            <span className="hs-fix-acts">
              <a className="link" href={state.url} target="_blank" rel="noreferrer">Open the sign-in page again<ExternalLink size={12} aria-hidden="true" /></a>
            </span>
          )}
        </div>
      )}
      {state.kind === 'setup_failed' && (
        <div className="hs-fix">
          <span role="alert" className="hs-problem">{state.retry === 'sign_in' ? 'Signing in didn’t finish' : 'Installing didn’t finish'}: {state.reason}</span>
          <span className="hs-fix-acts">
            <button type="button" className="btn btn-primary" onClick={state.retry === 'sign_in' ? onSignIn : onInstall}>Try again</button>
          </span>
          {terminalSteps && <ByHand>{terminalSteps}</ByHand>}
        </div>
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
          {guide.signIn
            ? <>
                <span>Sign in with your {guide.name} account. Your browser opens its sign-in page.</span>
                <span className="hs-fix-acts">
                  <button type="button" className="btn btn-primary" onClick={onSignIn}>Sign in to {guide.name}</button>
                  {checkAgain}
                </span>
                <ByHand><span>Paste this into Terminal and press Return:</span><CommandLine command={guide.signIn} /></ByHand>
              </>
            : <>
                <span>{state.reason}</span>
                <span className="hs-fix-acts">{checkAgain}<span className="t-meta">LoomWatch also checks again when you come back to this window.</span></span>
              </>}
        </div>
      )}
      {state.kind === 'needs_key' && (
        <div className="hs-fix">
          <span>{state.reason}</span>
          <span className="hs-fix-acts">{checkAgain}<span className="t-meta">LoomWatch also checks again when you come back to this window.</span></span>
        </div>
      )}
      {state.kind === 'restart' && (
        <div className="hs-fix">
          <span>
            {guide.name} was installed after LoomWatch started, so LoomWatch can’t start it yet. Stop LoomWatch (press Ctrl-C in
            its terminal window, or run <code className="t-mono-sm">{launcher} stop</code>), then open a new terminal window and run <code className="t-mono-sm">{launcher}</code> again.
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
      {state.kind === 'preparing' && (
        <p className="hs-note t-meta">{state.step}. LoomWatch does this once, so {guide.name} starts quickly from then on.</p>
      )}
      {state.kind === 'connector_failed' && (
        <div className="hs-fix">
          <span role="alert" className="hs-problem">LoomWatch couldn’t get {guide.name} ready: {state.reason}</span>
          <span className="hs-fix-acts"><button type="button" className="btn btn-primary" onClick={onPrepare}>Try again</button></span>
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
export function AppSetup({ harnesses, onChanged, onHide, firstTeam = false }: AppSetupProps) {
  const [report, setReport] = useState<readonly DetectedHarness[]>(harnesses)
  const [extras, setExtras] = useState<Pick<HarnessReport, 'connectors' | 'setup'>>({})
  const busy = Object.values(extras.setup ?? {}).some((job) => job.state === 'running')
    || Object.values(extras.connectors ?? {}).some((connector) => connector.state === 'preparing')
    || report.some((harness) => harness.connector?.state === 'preparing')
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
      const latest = await fetchHarnesses()
      setReport(latest.harnesses ?? [])
      setExtras({ connectors: latest.connectors, setup: latest.setup })
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
    const timer = window.setInterval(tick, busy ? SETUP_BUSY_POLL_MS : SETUP_POLL_MS)
    window.addEventListener('focus', back)
    document.addEventListener('visibilitychange', shown)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', back)
      document.removeEventListener('visibilitychange', shown)
    }
  }, [refresh, busy])

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

  const prepare = useCallback(async (id: string) => {
    try {
      await prepareHarness(id)
    } catch {
      // The next poll shows where it stands.
    }
    await refresh()
  }, [refresh])

  const signIn = useCallback(async (id: string) => {
    try {
      await signInHarness(id)
    } catch {
      // The next poll shows where it stands.
    }
    await refresh()
  }, [refresh])

  const install = useCallback(async (id: string) => {
    try {
      await installHarness(id)
    } catch {
      // The next poll shows where it stands.
    }
    await refresh()
  }, [refresh])

  const sendCode = useCallback(async (id: string, code: string) => {
    await sendSignInCode(id, code)
    await refresh()
  }, [refresh])

  // An app found after LoomWatch started gets its connector now; one found at start already has
  // it coming (the daemon starts those itself).
  const asked = useRef(new Set<string>())
  useEffect(() => {
    for (const harness of report) {
      if (harness.connector?.state !== 'needed' || asked.current.has(harness.id)) continue
      asked.current.add(harness.id)
      void prepare(harness.id)
    }
  }, [report, prepare])

  // Check an app the daemon holds no verdict for: as soon as it appears, and again when a verdict
  // the panel saw is gone (LoomWatch restarted, or its 10-minute record lapsed). A check that itself
  // left no verdict (the daemon was busy, say) is not repeated on every poll; it waits for
  // SETUP_RECHECK_MS, or for "Check".
  useEffect(() => {
    for (const harness of report) {
      if (harness.acpAvailable === false || checking.has(harness.id)) continue
      // Nothing to check until its connector is in: the check runs once it is (its signature changes).
      if (harness.connector && harness.connector.state !== 'ready' && harness.health === undefined) continue
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
    state: appSetupState(harness, harness ? checking.has(harness.id) : false, {
      ...(extras.connectors?.[guide.id] ? { connector: extras.connectors[guide.id] } : {}),
      ...(extras.setup?.[guide.id] ? { job: extras.setup[guide.id] } : {}),
    }),
  }))
  const ready = states.filter(({ state }) => state.kind === 'ready')

  // Tell the rest of LoomWatch when a verdict changes, so the footer, New team and the Library
  // stop offering a signed-out app and start offering a ready one. Not on the first render.
  const verdicts = report.map((harness) => `${harness.id}:${harness.health ?? '-'}:${harness.healthCause ?? '-'}:${harness.needsRestart ? 'restart' : '-'}:${harness.connector?.state ?? '-'}`).join(' ')
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
          <h2 id={titleId}>{ready.length > 1 ? 'Your AI apps are ready' : ready.length > 0 ? 'Your AI app is ready' : 'Set up an AI app'}</h2>
          <p>
            {ready.length > 0
              ? `${listNames(ready.map(({ guide }) => guide.name))} can run your agents now.${firstTeam ? ' Press New team to make your first team.' : ''} You can add another app below at any time.`
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
            connector={harness?.spawn.cmd === 'npx' && harness.connector?.state !== 'ready'}
            actions={{
              onCheck: () => { if (harness) void check(harness) },
              onPrepare: () => { void prepare(guide.id) },
              onInstall: () => { void install(guide.id) },
              onSignIn: () => { void signIn(guide.id) },
              onCode: (code) => sendCode(guide.id, code),
            }}
          />
        ))}
      </ul>
      <p className="home-setup-foot t-meta">{isWindows() ? 'PowerShell is in the Start menu.' : 'Terminal is in Applications › Utilities.'} LoomWatch also works with Hermes, OpenClaw, and Gemini CLI with a Gemini API key, if you already use them.</p>
    </section>
  )
}
