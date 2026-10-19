import { useEffect, useId, useState } from 'react'

import { type KeyStatus, fetchKeyStatus, recheckOpenRouterKey, removeOpenRouterKey, saveOpenRouterKey } from '../../lib/ai/client'
import { announceKeyStatus } from '../../lib/ai/useKeyStatus'
import { keyStore } from '../../lib/platform'

const KEYS_PAGE = 'https://openrouter.ai/keys'
const CREDITS_PAGE = 'https://openrouter.ai/settings/credits'
/** Where a key gets a credit limit, by month or for good: the one cap that covers every run, Ask and every schedule (ADR 0068). */
const LIMIT_PAGE = 'https://openrouter.ai/settings/keys'

function money(dollars: number): string {
  return dollars < 0.01 && dollars > 0 ? 'less than $0.01' : `$${dollars.toFixed(2)}`
}

/** What OpenRouter said about the key, in one line. */
function said(status: KeyStatus): string {
  const parts: string[] = []
  if (status.label) parts.push(`Key ${status.label}`)
  if (status.spentThisMonth !== undefined) parts.push(`${money(status.spentThisMonth)} this month`)
  if (status.spent !== undefined) parts.push(`${money(status.spent)} spent with this key`)
  if (status.limitRemaining !== undefined && status.limitRemaining !== null) parts.push(`${money(status.limitRemaining)} left under its limit`)
  return parts.join(' · ')
}

/**
 * The OpenRouter key every agent runs on: paste it once, LoomWatch checks it with OpenRouter and
 * keeps it in this Mac's Keychain, or Windows Credential Manager. The key is never shown again,
 * only what OpenRouter says about it.
 *
 * `variant="card"` is the short form Home shows when no key is set yet.
 */
export function OpenRouterKey({ variant = 'section', onChange }: { variant?: 'section' | 'card'; onChange?: (status: KeyStatus) => void }) {
  const [status, setStatus] = useState<KeyStatus | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  // Home and the Ask panel can both show the card, so its ids are its own.
  const headingId = useId()
  const inputId = useId()

  useEffect(() => {
    let active = true
    fetchKeyStatus()
      .then((value) => { announceKeyStatus(value); if (active) setStatus(value) })
      .catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : 'Couldn’t load the OpenRouter key.') })
    return () => { active = false }
  }, [])

  async function act(work: () => Promise<KeyStatus>, done: string) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const value = await work()
      setStatus(value)
      announceKeyStatus(value)
      onChange?.(value)
      setNotice(done)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const connected = status?.connected === true
  const heading = <h2 id={headingId} className="t-title">{variant === 'card' ? 'Add your OpenRouter key' : 'AI models'}</h2>

  return (
    <section className={variant === 'card' ? 'e1 lw-settings-section lw-key-card' : 'e1 lw-settings-section'} aria-labelledby={headingId} aria-busy={busy}>
      {heading}
      {error && <p role="alert" className="inline-error t-body"><span className="detail">{error}</span></p>}
      {notice && <p role="status" className="lw-notice t-meta">{notice}</p>}
      {!status && !error && <p role="status" className="t-meta lw-settings-quiet">Loading…</p>}
      {connected && status && <>
        <p className="t-body">Your agents run on <strong>OpenRouter</strong>, which reaches models from Anthropic, OpenAI, Google and others with one key.</p>
        <div className="e2 lw-settings-row">
          <span className="t-body-m">Key</span>
          <span className="t-meta">{said(status) || 'Connected.'}</span>
          {status.freeTier && <span className="t-meta">This account has no credits yet, so only free models work. <a className="link" href={CREDITS_PAGE} target="_blank" rel="noreferrer">Add credits</a> to use the others.</span>}
          {status.problem && <span className="t-meta inline-error">{status.problem}</span>}
          <span className="t-meta"><a className="link" href={LIMIT_PAGE} target="_blank" rel="noreferrer">Set a monthly limit on this key</a> at openrouter.ai: it holds every run, Ask and every schedule. Each team’s own limit stops one run.</span>
          <span className="t-meta lw-settings-quiet">Each run costs what its model calls cost on OpenRouter; the run’s receipt shows the exact amount. The key is kept in {keyStore()}, outside your team files, and agents never see it.</span>
        </div>
        <div className="lw-settings-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => void act(recheckOpenRouterKey, 'Checked with OpenRouter.')}>{busy ? 'Checking…' : 'Check again'}</button>
          <button type="button" className="link alert" disabled={busy} onClick={() => void act(removeOpenRouterKey, 'The key is removed. Agents can’t run until you add one.')}>Remove key</button>
        </div>
      </>}
      {status && !connected && <>
        <p className="t-body">LoomWatch’s agents run on AI models through <strong>OpenRouter</strong>. One key reaches models from Anthropic, OpenAI, Google and others. You pay as you go, from credit you add at OpenRouter.</p>
        <ol className="t-body lw-settings-steps">
          <li><a className="link" href={KEYS_PAGE} target="_blank" rel="noreferrer">Open OpenRouter’s keys page</a>, sign in or make an account, and create a key.</li>
          <li>Copy the key and paste it here. It starts with <span className="mono">sk-or-</span>.</li>
          <li><a className="link" href={CREDITS_PAGE} target="_blank" rel="noreferrer">Add a few dollars of credit</a>: your agents spend it as they work. A short run on a small model costs a cent or less.</li>
        </ol>
        <form className="field" onSubmit={(event) => {
          event.preventDefault()
          const submitted = key
          setKey('')
          void act(() => saveOpenRouterKey(submitted), 'OpenRouter accepted the key. Your agents can run now.')
        }}>
          <label className="t-meta" htmlFor={inputId}>OpenRouter key</label>
          <input id={inputId} type="password" autoComplete="off" spellCheck={false} value={key} maxLength={512} placeholder="sk-or-…" onChange={(event) => setKey(event.target.value)} className="input mono" />
          <span className="hint t-meta">LoomWatch checks it with OpenRouter first, then keeps it in {keyStore()}. It is never shown again, and agents never see it.</span>
          <button disabled={busy || !key.trim()} className="btn btn-primary lw-settings-start">{busy ? 'Checking the key…' : 'Save key'}</button>
        </form>
      </>}
    </section>
  )
}
