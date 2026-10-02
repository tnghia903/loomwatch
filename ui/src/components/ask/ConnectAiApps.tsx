import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'

import { connectApp, disconnectApp, fetchConnections, type ConnectableApp, type Connections } from '../../lib/ask/client'

function status(app: ConnectableApp): string {
  if (app.connected) return 'Connected'
  if (app.method === 'snippet') return 'Paste a snippet into its settings'
  return app.detected ? 'Ready to connect' : 'Not installed on this computer'
}

/**
 * Settings → Connections: let the person's own AI apps use LoomWatch's tools (ADR 0033). One click
 * runs the app's own "add an MCP server" command; apps that have none get a snippet to paste.
 * Connected apps can build, change and run teams, and never answer a review stop.
 */
export function ConnectAiApps() {
  const [connections, setConnections] = useState<Connections | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [snippets, setSnippets] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchConnections(controller.signal).then((value) => {
      // A daemon from before this section answers something else, or nothing useful.
      if (Array.isArray(value?.apps)) setConnections(value)
      else setError('Connecting AI apps needs the updated LoomWatch. Stop it and start it again, then reload this page.')
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught))
    })
    return () => controller.abort()
  }, [])

  const replace = (next: ConnectableApp) => setConnections((current) => current && { ...current, apps: current.apps.map((app) => (app.id === next.id ? { ...app, ...next } : app)) })

  async function connect(app: ConnectableApp) {
    setBusy(app.id)
    setProblems(({ [app.id]: _dropped, ...rest }) => rest)
    setNotes(({ [app.id]: _dropped, ...rest }) => rest)
    try {
      const result = await connectApp(app.id)
      replace(result)
      if (result.snippet) setSnippets((current) => ({ ...current, [app.id]: JSON.stringify(result.snippet, null, 2) }))
      else setNotes((current) => ({ ...current, [app.id]: `Done. Open ${app.name} and ask it to use LoomWatch — for example, “make me a LoomWatch team that summarises my inbox”.` }))
    } catch (caught) {
      setProblems((current) => ({ ...current, [app.id]: caught instanceof Error ? caught.message : String(caught) }))
    } finally {
      setBusy(null)
    }
  }

  async function disconnect(app: ConnectableApp) {
    setBusy(app.id)
    setProblems(({ [app.id]: _dropped, ...rest }) => rest)
    try {
      const result = await disconnectApp(app.id)
      replace({ ...app, connected: false, connectedAt: null })
      setSnippets(({ [app.id]: _dropped, ...rest }) => rest)
      setNotes((current) => ({ ...current, [app.id]: result?.note ?? `Disconnected. ${app.name} can no longer use LoomWatch.` }))
    } catch (caught) {
      setProblems((current) => ({ ...current, [app.id]: caught instanceof Error ? caught.message : String(caught) }))
    } finally {
      setBusy(null)
    }
  }

  async function copy(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(id)
      window.setTimeout(() => setCopied((current) => (current === id ? null : current)), 1600)
    } catch {
      setCopied(null)
    }
  }

  return (
    <section className="e1 lw-settings-section" aria-labelledby="ai-apps-heading" aria-busy={busy !== null}>
      <h2 id="ai-apps-heading" className="t-title">Use LoomWatch from your AI apps</h2>
      <p className="t-body">Connect Claude Code, Codex or another AI app, then ask it for a team in your own words. It can set teams up, propose changes and start runs here. Only you answer a team’s review steps.</p>
      {error && <p role="alert" className="inline-error t-body"><span className="detail">{error}</span></p>}
      {!connections && !error && <p role="status" className="t-meta lw-settings-quiet">Looking for your AI apps…</p>}
      {connections && (
        <ul className="lw-ai-apps">
          {connections.apps.map((app) => (
            <li key={app.id} className="e2 lw-settings-row lw-ai-app">
              <div className="lw-ai-app-head">
                <span className="t-body-m">{app.name}</span>
                <span className={`t-meta lw-ai-app-status ${app.connected ? 'connected' : ''}`}>{app.connected && <Check size={13} aria-hidden="true" />}{status(app)}</span>
                {app.connected ? (
                  <button type="button" className="btn" disabled={busy !== null} onClick={() => void disconnect(app)}>{busy === app.id ? 'Disconnecting…' : 'Disconnect'}</button>
                ) : (
                  <button type="button" className="btn btn-act" disabled={busy !== null || (app.method === 'command' && !app.detected)} onClick={() => void connect(app)}>
                    {busy === app.id ? 'Connecting…' : app.method === 'snippet' ? 'Get snippet' : 'Connect'}
                  </button>
                )}
              </div>
              {problems[app.id] && <p role="alert" className="t-meta lw-ai-app-problem">{problems[app.id]}</p>}
              {notes[app.id] && <p role="status" className="t-meta lw-settings-quiet">{notes[app.id]}</p>}
              {snippets[app.id] && (
                <div className="lw-ai-snippet">
                  <p className="t-meta">Paste this into {app.snippetPlace}, then restart {app.name}. It holds a private key: don’t share it.</p>
                  <pre className="t-mono-sm">{snippets[app.id]}</pre>
                  <button type="button" className="btn" onClick={() => void copy(app.id, snippets[app.id])}>{copied === app.id ? <><Check size={14} aria-hidden="true" />Copied</> : <><Copy size={14} aria-hidden="true" />Copy</>}</button>
                </div>
              )}
              {app.method === 'command' && app.command && (
                <details className="lw-ai-command">
                  <summary className="t-meta">What LoomWatch runs</summary>
                  <code className="t-mono-sm">{app.command}</code>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
      {connections && <p className="t-meta lw-settings-quiet">Apps reach LoomWatch at <code>{connections.url}</code>, on this computer only. Disconnecting stops LoomWatch answering that app straight away.</p>}
    </section>
  )
}
