import { useId, useState } from 'react'

import { type ClaudeStatus, recheckClaudeKey, removeClaudeKey, saveClaudeKey } from '../../lib/ai/client'
import { sourceMaker } from '../../lib/ai/makers'
import { CLAUDE_BILLING_PAGE, SOURCE_INFO } from '../../lib/ai/sources'
import { refreshModels } from '../../lib/ai/useModels'
import { announceAiStatus, useAiStatus } from '../../lib/ai/useKeyStatus'
import { keyStore } from '../../lib/platform'
import { MakerMark } from '../models/MakerMark'

const CLAUDE_BILLING_SETTINGS = 'https://claude.ai/settings/billing'
const CONSOLE_KEYS = 'https://platform.claude.com/settings/keys'

/**
 * The person's Claude Max or Team plan, through its monthly API credit (ADR 0073): they link a
 * Claude Console organization to the plan, make an API key there and paste it here. LoomWatch checks
 * it with Anthropic first, then keeps it in this Mac's Keychain or Windows Credential Manager.
 * Anthropic doesn't let apps use a Claude sign-in, so a key is the only way.
 */
export function ClaudeCredit({ variant = 'section' }: { variant?: 'section' | 'card' }) {
  const ai = useAiStatus()
  const status: ClaudeStatus | null = ai?.anthropic ?? null
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const headingId = useId()
  const inputId = useId()

  async function act(work: () => Promise<ClaudeStatus>, done: string) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const value = await work()
      announceAiStatus({ anthropic: value })
      void refreshModels().catch(() => {})
      if (value.problem) setError(value.problem)
      else setNotice(done)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const info = SOURCE_INFO.anthropic
  const connected = status?.connected === true
  return (
    <section className={variant === 'card' ? 'e1 lw-settings-section lw-source-card' : 'e1 lw-settings-section'} aria-labelledby={headingId} aria-busy={busy}>
      <h2 id={headingId} className="t-title lw-source-title"><MakerMark maker={sourceMaker('anthropic')} />{info.heading}</h2>
      <p className="t-meta lw-source-cost">{info.cost}</p>
      {error && <p role="alert" className="inline-error t-body"><span className="detail">{error}</span></p>}
      {notice && <p role="status" className="lw-notice t-meta">{notice}</p>}
      {!status && !error && <p role="status" className="t-meta lw-settings-quiet">Loading…</p>}

      {connected && status && <>
        <div className="e2 lw-settings-row">
          <span className="t-body-m">Key</span>
          <span className="t-meta">{status.label ?? 'Connected.'}{status.models?.length ? ` · ${status.models.length} Claude models` : ''}</span>
          <span className="t-meta">Anthropic doesn’t tell apps how much credit is left. <a className="link" href={CLAUDE_BILLING_PAGE} target="_blank" rel="noreferrer">See the exact balance</a> in the Claude Console; the Usage page shows what LoomWatch has spent.</span>
          <span className="t-meta lw-settings-quiet">Each call’s cost is worked out from Claude’s list prices, so receipts show it with “≈”. The key is kept in {keyStore()}, outside your team files, and agents never see it.</span>
        </div>
        <div className="lw-settings-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => void act(recheckClaudeKey, 'Checked with Anthropic.')}>{busy ? 'Checking…' : 'Check again'}</button>
          <button type="button" className="link alert" disabled={busy} onClick={() => void act(removeClaudeKey, 'The key is removed. Agents on your Claude credit can’t run until you add one.')}>Remove key</button>
        </div>
      </>}

      {status && !connected && <>
        <p className="t-body">Claude Max and Team plans come with monthly API credit: $100 on Max 5x, $200 on Max 20x, up to $500 on Team. Pro and Free plans have none.</p>
        <ol className="t-body lw-settings-steps">
          <li>On claude.ai, open <a className="link" href={CLAUDE_BILLING_SETTINGS} target="_blank" rel="noreferrer">Settings → Billing</a> and, under API credits, link a Claude Console organization.</li>
          <li>In that organization, open <a className="link" href={CONSOLE_KEYS} target="_blank" rel="noreferrer">API keys</a> and create a key.</li>
          <li>Copy the key and paste it here. It starts with <span className="mono">sk-ant-api</span>.</li>
        </ol>
        <form className="field" onSubmit={(event) => {
          event.preventDefault()
          const submitted = key
          setKey('')
          void act(() => saveClaudeKey(submitted), 'Anthropic accepted the key. Agents can run on your Claude credit now.')
        }}>
          <label className="t-meta" htmlFor={inputId}>Claude API key</label>
          <input id={inputId} type="password" autoComplete="off" spellCheck={false} value={key} maxLength={512} placeholder="sk-ant-api…" onChange={(event) => setKey(event.target.value)} className="input mono" />
          <span className="hint t-meta">LoomWatch checks it with Anthropic first, then keeps it in {keyStore()}. It is never shown again, and agents never see it.</span>
          <button disabled={busy || !key.trim()} className="btn btn-primary lw-settings-start">{busy ? 'Checking the key…' : 'Save key'}</button>
        </form>
      </>}
    </section>
  )
}
