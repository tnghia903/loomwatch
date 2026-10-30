import { ExternalLink } from '../ui/icon'
import { useEffect, useId, useRef, useState } from 'react'

import { AI_CHANNEL, type ChatGptStatus, type SignInOutcome, checkChatGpt, signOutChatGpt, startChatGptSignIn } from '../../lib/ai/client'
import { sourceMaker } from '../../lib/ai/makers'
import { CHATGPT_USAGE_PAGE, SOURCE_INFO } from '../../lib/ai/sources'
import { refreshModels } from '../../lib/ai/useModels'
import { announceAiStatus, reloadAiStatus, useAiStatus } from '../../lib/ai/useKeyStatus'
import { keyStore } from '../../lib/platform'
import { MakerMark } from '../models/MakerMark'

/** A prepared consent page is used for this long; OpenAI keeps a sign-in open for ten minutes. */
const FRESH_FOR_MS = 8 * 60_000
const WELCOMED = 'loomwatch.chatgpt.welcomed'

const OUTCOME_SAID: Record<Exclude<SignInOutcome, 'connected'>, string> = {
  plan_use_off: 'You signed in without allowing LoomWatch to use your plan. Turn it on to run agents on it.',
  denied: 'You didn’t allow LoomWatch, so nothing was connected.',
  expired: 'That sign-in took too long or was finished elsewhere. Continue with ChatGPT again.',
  failed: 'ChatGPT sent LoomWatch back without a sign-in it could use. Continue with ChatGPT again.',
  storage: `LoomWatch couldn’t keep the sign-in in ${keyStore()}. Unlock it, then continue with ChatGPT again.`,
}

function welcomed(): boolean {
  try { return window.localStorage.getItem(WELCOMED) === '1' } catch { return true }
}

/**
 * The person's ChatGPT Plus or Pro plan (ADR 0073): one click opens ChatGPT's own page in a new tab,
 * where they sign in and allow LoomWatch; this card carries on by itself when they come back.
 * LoomWatch never sees the password, and agents never see the sign-in. `onConnected` hears when a
 * sign-in it started comes back with plan use on, as the first run waits to. `fill={false}` makes its
 * Continue a gold ring, where another button is the screen's one gold fill.
 */
export function ChatGptPlan({ variant = 'section', onConnected, fill = true }: { variant?: 'section' | 'card'; onConnected?: () => void; fill?: boolean }) {
  const ai = useAiStatus()
  const connectedHeard = useRef(onConnected)
  useEffect(() => { connectedHeard.current = onConnected })
  const status: ChatGptStatus | null = ai?.chatgpt ?? null
  const [consent, setConsent] = useState<{ url: string; at: number } | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [welcome, setWelcome] = useState(false)
  const headingId = useId()
  const connected = status?.connected === true
  const needsSignIn = status !== null && status.available && (!connected || !status.planUse)
  const wasConnected = useRef(connected && status?.planUse === true)

  // The consent page's address, made ready before the click so one click opens it.
  useEffect(() => {
    if (!needsSignIn) return
    let current = true
    const prepare = () => {
      startChatGptSignIn()
        .then((url) => { if (current) setConsent({ url, at: Date.now() }) })
        .catch((caught: unknown) => { if (current) setError(caught instanceof Error ? caught.message : 'Couldn’t start the sign-in with ChatGPT.') })
    }
    prepare()
    const timer = window.setInterval(prepare, FRESH_FOR_MS)
    return () => { current = false; window.clearInterval(timer) }
  }, [needsSignIn])

  // Waiting on the sign-in in another tab: its landing page says how it went, and a look now and
  // then catches one finished where that message can't reach.
  useEffect(() => {
    if (!waiting) return
    let current = true
    const settle = async () => {
      const latest = await reloadAiStatus()
      if (current && latest.chatgpt.connected) {
        current = false
        setWaiting(false)
        setError('')
        void refreshModels().catch(() => {})
        if (latest.chatgpt.planUse) connectedHeard.current?.()
      }
    }
    let channel: BroadcastChannel | null = null
    try {
      channel = new BroadcastChannel(AI_CHANNEL)
      channel.onmessage = (event: MessageEvent<{ source?: string; outcome?: SignInOutcome }>) => {
        const outcome = event.data?.outcome
        if (event.data?.source !== 'chatgpt' || !outcome) return
        if (outcome !== 'connected') setError(OUTCOME_SAID[outcome])
        if (outcome === 'connected' || outcome === 'plan_use_off') void settle().catch(() => {})
        else setWaiting(false)
      }
    } catch { /* an old browser: the look below still catches it */ }
    const timer = window.setInterval(() => { void settle().catch(() => {}) }, 3000)
    return () => { current = false; channel?.close(); window.clearInterval(timer) }
  }, [waiting])

  // The first time plan use is on, the person is told what it means, once.
  useEffect(() => {
    const on = connected && status?.planUse === true
    if (on && !wasConnected.current && !welcomed()) setWelcome(true)
    wasConnected.current = on
  }, [connected, status?.planUse])

  if (!status || !status.available) return null

  async function act(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await work() } catch (caught) { setError(caught instanceof Error ? caught.message : 'Something went wrong. Try again.') } finally { setBusy(false) }
  }

  const begin = (event: React.MouseEvent<HTMLAnchorElement>) => {
    setError('')
    if (!consent || Date.now() - consent.at > FRESH_FOR_MS) {
      // Not ready, or too old: make it again, and the next click opens it.
      event.preventDefault()
      void startChatGptSignIn().then((url) => setConsent({ url, at: Date.now() })).catch(() => setError('Couldn’t start the sign-in with ChatGPT.'))
      return
    }
    setWaiting(true)
  }

  const info = SOURCE_INFO.chatgpt
  const continueButton = (label: string) => (
    <a className={`btn ${fill ? 'btn-primary' : 'btn-ring'} lw-chatgpt-continue`} href={consent?.url ?? '#'} target="_blank" rel="noopener noreferrer" aria-disabled={!consent} onClick={begin}>
      <MakerMark maker={sourceMaker('chatgpt')} />{label}
    </a>
  )

  return (
    <section className={variant === 'card' ? 'e1 lw-settings-section lw-source-card' : 'e1 lw-settings-section'} aria-labelledby={headingId} aria-busy={busy || waiting}>
      <h2 id={headingId} className="t-title lw-source-title"><MakerMark maker={sourceMaker('chatgpt')} />{info.heading}</h2>
      <p className="t-meta lw-source-cost">{info.cost}</p>
      {error && <p role="alert" className="inline-error t-body"><span className="detail">{error}</span></p>}
      {notice && <p role="status" className="lw-notice t-meta">{notice}</p>}
      {welcome && (
        <div role="status" className="e2 lw-settings-row lw-chatgpt-welcome">
          <span className="t-body-m">You’re using your ChatGPT plan</span>
          <span className="t-meta">Agents on ChatGPT models now count against your Plus or Pro plan’s limits, not against any money. You can see and limit LoomWatch’s share in ChatGPT’s settings.</span>
          <span className="lw-settings-actions">
            <button type="button" className="btn" onClick={() => { setWelcome(false); try { window.localStorage.setItem(WELCOMED, '1') } catch { /* shown again next time */ } }}>Got it</button>
            <a className="link" href={CHATGPT_USAGE_PAGE} target="_blank" rel="noreferrer">Manage usage</a>
          </span>
        </div>
      )}

      {connected && <>
        <div className="e2 lw-settings-row">
          <span className="t-body-m">{status.planUse ? 'Using ChatGPT plan' : 'Signed in, plan use off'}</span>
          {status.email && <span className="t-meta">Signed in as {status.email}</span>}
          {status.planUse && status.models?.length ? <span className="t-meta">{status.models.length} models: {status.models.slice(0, 3).map((model) => model.name).join(', ')}{status.models.length > 3 ? ', …' : ''}</span> : null}
          {!status.planUse && <span className="t-meta inline-error">LoomWatch can’t use your plan until you allow it. Continue with ChatGPT and allow it on the page that opens.</span>}
          {status.problem && <span className="t-meta inline-error">{status.problem}</span>}
          <span className="t-meta lw-settings-quiet">Only ChatGPT Plus and Pro plans can be used. LoomWatch keeps the sign-in in {keyStore()}; agents never see it.</span>
        </div>
        <div className="lw-settings-actions">
          {!status.planUse && continueButton('Turn on plan use')}
          {status.planUse && <a className="btn" href={CHATGPT_USAGE_PAGE} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden="true" />Manage usage</a>}
          <button type="button" className="btn" disabled={busy} onClick={() => void act(async () => {
            const checked = await checkChatGpt()
            announceAiStatus({ chatgpt: checked })
            void refreshModels().catch(() => {})
            setNotice(checked.problem ? '' : 'Checked with ChatGPT.')
            if (checked.problem) setError(checked.problem)
          })}>{busy ? 'Checking…' : 'Check again'}</button>
          <button type="button" className="link alert" disabled={busy} onClick={() => void act(async () => {
            const { chatgpt, revoked } = await signOutChatGpt()
            announceAiStatus({ chatgpt })
            void refreshModels().catch(() => {})
            setNotice(revoked ? 'Signed out. Agents on ChatGPT models can’t run until you sign in again.' : 'Signed out here, but ChatGPT didn’t confirm it. Remove LoomWatch in ChatGPT’s settings to be sure.')
          })}>Sign out</button>
        </div>
      </>}

      {!connected && <>
        <p className="t-body">Use the ChatGPT Plus or Pro plan you already pay for. You sign in on ChatGPT’s own page and allow LoomWatch; LoomWatch never sees your password.</p>
        {waiting
          ? <p className="t-body">Finish signing in on ChatGPT’s page, in the tab that opened. This card carries on by itself when you’re done.</p>
          : null}
        <div className="lw-settings-actions">{continueButton(waiting ? 'Open the sign-in again' : 'Continue with ChatGPT')}</div>
      </>}
    </section>
  )
}
