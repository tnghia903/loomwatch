import { useState } from 'react'

import { checkTool, keptInWords, removeTool, useConnectedTools, type ConnectedTool } from '../../lib/tools/client'
import { ConnectTool } from '../tools/ConnectTool'

/** The longest description of a call shown in the list. */
const DESCRIPTION_CHARS = 140

/**
 * Connections' Tools section (ADR 0069): every tool connected in LoomWatch, what each offers, and
 * connecting, checking, signing in again or removing one. Which agent may use which tool is the
 * agent's own Tools block.
 */
export function ConnectedTools() {
  const tools = useConnectedTools()
  const [connecting, setConnecting] = useState<ConnectedTool | 'new' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function act(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await work() } catch (caught) { setError(caught instanceof Error ? caught.message : 'That didn’t work. Try again.') }
    finally { setBusy(false); tools.refresh() }
  }

  const listed = tools.state === 'ready' ? tools.tools : []
  return (
    <section className="e1 lw-settings-section" aria-labelledby="tools-heading" aria-busy={busy}>
      <h2 id="tools-heading" className="t-title">Tools</h2>
      <p className="t-body lw-settings-quiet">Connect a service your agents can use, such as Linear or GitHub, then give it to an agent in its Tools block. Each call it makes there asks you first, unless you always allow it.</p>
      {error && <p role="alert" className="inline-error t-body"><span className="detail">{error}</span></p>}
      {notice && <p role="status" className="lw-notice t-meta">{notice}</p>}
      {tools.state === 'loading' && <p role="status" className="t-meta lw-settings-quiet">Loading tools…</p>}
      {tools.state === 'unavailable' && <p className="t-meta lw-settings-quiet">{tools.message}</p>}
      {listed.length > 0 && <ul className="tools-connected" aria-label="Connected tools">
        {listed.map((tool) => (
          <li key={tool.id}>
            <div className="tools-connected-head">
              <b>{tool.name}</b>
              <span className="t-meta">{tool.pending ? 'Not finished connecting' : `${tool.calls.length} call${tool.calls.length === 1 ? '' : 's'} · ${tool.auth === 'signIn' ? 'signed in' : tool.auth === 'token' ? 'with a token' : 'no sign-in'}`}</span>
            </div>
            <p className="t-meta">{tool.url}</p>
            {tool.problem && <p className="t-meta problem">{tool.problem}</p>}
            {tool.calls.length > 0 && <details>
              <summary>What it offers</summary>
              <ul>{tool.calls.map((call) => <li key={call.name}><strong>{call.label}</strong>{call.readOnly ? ' · only reads' : ''}{call.description ? ` — ${call.description.length > DESCRIPTION_CHARS ? `${call.description.slice(0, DESCRIPTION_CHARS - 1).trimEnd()}…` : call.description}` : ''}</li>)}</ul>
            </details>}
            <div className="lw-settings-actions">
              {tool.pending
                ? <button type="button" className="link" disabled={busy} onClick={() => setConnecting(tool)}>Finish connecting</button>
                : <button type="button" className="link" disabled={busy} onClick={() => void act(async () => { const checked = await checkTool(tool.id); setNotice(`${checked.name} offers ${checked.calls.length} call${checked.calls.length === 1 ? '' : 's'}.`) })}>Check again</button>}
              {!tool.pending && tool.auth === 'signIn' && <button type="button" className="link" disabled={busy} onClick={() => setConnecting(tool)}>Sign in again</button>}
              {!tool.pending && tool.auth === 'token' && <button type="button" className="link" disabled={busy} onClick={() => setConnecting(tool)}>Replace its token</button>}
              <button type="button" className="link alert" disabled={busy} onClick={() => void act(async () => { await removeTool(tool.id); setNotice(`${tool.name} is removed. Agents given it can’t use it until you connect it again.`) })}>Remove {tool.name}</button>
            </div>
          </li>
        ))}
      </ul>}
      {tools.state === 'ready' && (connecting
        ? <ConnectTool
            catalog={tools.catalog}
            connected={tools.tools}
            keptIn={tools.keptIn}
            resume={connecting === 'new' ? null : connecting}
            onClose={() => setConnecting(null)}
            onConnected={(tool) => { setConnecting(null); tools.refresh(); setError(''); setNotice(`${tool.name} is connected. Give it to an agent in its Tools block.`) }}
          />
        : <button type="button" className="btn btn-primary lw-settings-start" onClick={() => setConnecting('new')}>Connect a tool</button>)}
      {tools.state === 'ready' && <p className="t-meta lw-settings-quiet">Sign-ins and tokens are kept in {keptInWords(tools.keptIn)}, outside your team files. Agents never get them: LoomWatch makes each call for them.</p>}
    </section>
  )
}
