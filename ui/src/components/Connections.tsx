import { ArrowLeft } from 'lucide-react'
import { useEffect, useState } from 'react'

import { ConnectAiApps } from './ask/ConnectAiApps'

type Page = { id: string; title: string }
/** `via`: `signIn` when the operator connected with their Notion account, `token` under Advanced. */
type Connection = { connected: boolean; name?: string; destination?: Page | null; via?: 'signIn' | 'token' }
type Results = { pages: Page[]; nextCursor: string | null }

/**
 * How a Notion sign-in ended: the daemon's callback sends the browser back to
 * `/connections?notion=<outcome>` (`sign_in.rs`), and this page says it in words.
 */
const SIGN_IN_OUTCOMES: Record<string, { notice?: string; error?: string }> = {
  connected: { notice: 'Notion is connected. Choose the page your teams’ answers go under.' },
  denied: { error: 'Notion sign-in was canceled. Nothing changed.' },
  expired: { error: 'That sign-in took too long or was already used. Click Connect Notion to try again.' },
  failed: { error: 'Notion sign-in didn’t finish. Check your internet connection and try again.' },
  storage: { error: 'The secure credential store is unavailable. Unlock your macOS Keychain and try again.' },
}
const readSignInOutcome = () => new URLSearchParams(window.location.search).get('notion')

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/notion/${path}`, {
    method, cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-LoomWatch-Request': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok) throw new Error(result?.error ?? 'Connections are unavailable. Restart the updated LoomWatch daemon on a local address.')
  return result as T
}

// Connections is a settings surface, so it is a reading column rather than a canvas:
// same tokens, e1 sections, no second visual language. The `lw-settings-*` classes in
// styles/settings.css are that standard — every section added here follows them.
export default function Connections() {
  const [outcome] = useState(readSignInOutcome)
  const [connection, setConnection] = useState<Connection | null>(null)
  const [token, setToken] = useState('')
  const [query, setQuery] = useState('')
  const [searchedQuery, setSearchedQuery] = useState('')
  const [results, setResults] = useState<Results | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(() => (outcome && SIGN_IN_OUTCOMES[outcome]?.error) || '')
  const [notice, setNotice] = useState(() => (outcome && SIGN_IN_OUTCOMES[outcome]?.notice) || '')

  // The outcome is said once; a reload or a bookmark of this address must not say it again.
  useEffect(() => {
    if (outcome === null) return
    const url = new URL(window.location.href)
    url.searchParams.delete('notion')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [outcome])

  useEffect(() => {
    let active = true
    void (async () => {
      const value = await request<Connection>('connection')
      if (!active) return
      setConnection(value)
      // Back from Notion: list pages straight away, so choosing one is the next click.
      if (outcome === 'connected' && value.connected) {
        const found = await request<Results>('pages', 'POST', { query: '' })
        if (active) { setResults(found); setSearchedQuery('') }
      }
    })().catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : 'Could not load connections.') })
    return () => { active = false }
  }, [outcome])

  async function act(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await work() } catch (caught) { setError(caught instanceof Error ? caught.message : 'Something went wrong. Retry.') }
    finally { setBusy(false) }
  }
  async function search(more = false) {
    const value = await request<Results>('pages', 'POST', { query: more ? searchedQuery : query, ...(more ? { cursor: results?.nextCursor } : {}) })
    setResults({ ...value, pages: more ? [...(results?.pages ?? []), ...value.pages].filter((p, i, all) => all.findIndex((v) => v.id === p.id) === i) : value.pages })
    if (!more) setSearchedQuery(query)
  }
  async function signIn() {
    const { url } = await request<{ url: string }>('sign-in', 'POST', {})
    window.location.assign(url)
  }

  return (
    <main className="lw-settings">
      <div className="lw-settings-column">
        <a href="/" className="link lw-settings-back"><ArrowLeft size={14} aria-hidden="true" /> Back to the canvas</a>
        <div className="lw-settings-head">
          <h1 className="t-display">Connections</h1>
          <p className="t-body">Connect your tools and choose where your work belongs.</p>
        </div>
        <ConnectAiApps />
        <section className="e1 lw-settings-section" aria-labelledby="notion-heading" aria-busy={busy}>
          <h2 id="notion-heading" className="t-title">Notion</h2>
          {error && <p role="alert" className="inline-error t-body"><span className="detail">{error}</span></p>}
          {notice && <p role="status" className="lw-notice t-meta">{notice}</p>}
          {!connection && !error && <p role="status" className="t-meta lw-settings-quiet">Loading connection…</p>}
          {!connection && error && <button type="button" className="btn lw-settings-start" disabled={busy} onClick={() => void act(async () => setConnection(await request<Connection>('connection')))}>Retry</button>}
          {connection?.connected ? <>
            <p className="t-body">Connected to <strong>{connection.name}</strong></p>
            <p className="t-meta lw-settings-quiet">{connection.via === 'signIn'
              ? 'Connected with your Notion account. LoomWatch keeps the sign-in in this Mac’s Keychain and renews it on its own; if it ever lapses, connect again here. Disconnecting removes it; existing Notion pages remain.'
              : 'Your token is stored in this Mac’s Keychain. Disconnecting removes LoomWatch’s saved credentials; existing Notion pages remain.'}</p>
            <div className="e2 lw-settings-row">
              <span className="t-body-m">Destination page</span>
              <span className="t-meta">{connection.destination ? connection.destination.title : 'Choose the page your teams’ answers go under.'}</span>
              <span className="t-meta lw-settings-quiet">Each answer becomes a new page under it. To send a team’s answers here, open the team, select its <strong>Team response</strong> on the canvas, and turn on <strong>Send every answer to Notion</strong>.</span>
            </div>
            <form className="lw-settings-search" onSubmit={(event) => { event.preventDefault(); void act(() => search()) }}>
              <label className="field"><span className="t-meta">Find a page</span><input className="input" value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} placeholder="Search by title, or leave blank" /></label>
              <button className="btn btn-primary" disabled={busy}>Search</button>
            </form>
            {results && <div className="lw-settings-results">
              {results.pages.length === 0 && <p className="t-meta lw-settings-quiet">{connection.via === 'signIn'
                ? 'No pages found. Try another word, or leave the search blank to see recent pages.'
                : 'No pages found. In Notion, open your page → ••• → Connections and add your integration, then search again.'}</p>}
              <ul className="pop-list">
                {results.pages.map((page) => <li key={page.id}><button type="button" disabled={busy} className={`pop-row ${page.id === connection.destination?.id ? 'current' : ''}`} onClick={() => void act(async () => {
                  setConnection(await request<Connection>('destination', 'PUT', { pageId: page.id })); setNotice('Destination saved.')
                })}><span className="name t-body">{page.title}</span>{page.id === connection.destination?.id && <span className="aside t-meta">Selected</span>}</button></li>)}
              </ul>
              {results.nextCursor && <button disabled={busy} type="button" className="link lw-settings-start" onClick={() => void act(() => search(true))}>Load more pages</button>}
            </div>}
            <button type="button" disabled={busy} className="link alert lw-settings-start" onClick={() => void act(async () => {
              setConnection(await request<Connection>('connection', 'DELETE')); setResults(null); setToken(''); setNotice('Disconnected from Notion.')
            })}>Disconnect Notion</button>
          </> : connection && <>
            <p className="t-body lw-settings-quiet">Connect your Notion account, then choose the page your teams’ answers go under. Each answer becomes a new page there.</p>
            <button type="button" className="btn btn-primary lw-settings-start" disabled={busy} onClick={() => void act(signIn)}>{busy ? 'Opening Notion…' : 'Connect Notion'}</button>
            <p className="t-meta lw-settings-quiet">Notion asks you to allow LoomWatch. Because it sends you back to this computer, it also asks you to tick <strong>I recognize and trust this URL</strong> first. The sign-in is kept in this Mac’s Keychain, outside your team files.</p>
            <details className="lw-settings-advanced">
              <summary className="t-meta">Advanced: connect with an integration token</summary>
              <p className="t-meta lw-settings-quiet">For workspaces that only allow AI apps an admin has approved.</p>
              <ol className="t-body lw-settings-steps">
                <li><a className="link" href="https://www.notion.so/profile/integrations" target="_blank" rel="noreferrer">Create an internal Notion integration</a> for your workspace. Enable Read, Insert and Update content.</li>
                <li>In Notion, open your destination page, choose <strong>••• → Connections</strong>, and add that integration.</li>
                <li>Copy its integration token and paste it below. A workspace owner may need to create the integration for you.</li>
              </ol>
              <form className="field" onSubmit={(event) => { event.preventDefault(); const submitted = token; setToken(''); void act(async () => {
                setConnection(await request<Connection>('connection', 'POST', { token: submitted })); setNotice('Connected. Search for your destination page below.')
              }) }}>
                <label className="t-meta" htmlFor="notion-token">Notion integration token</label>
                <input id="notion-token" type="password" autoComplete="off" spellCheck={false} value={token} onChange={(event) => setToken(event.target.value)} maxLength={4096} className="input mono" />
                <span className="hint t-meta">Stored securely in macOS Keychain, outside your team files. LoomWatch never displays the saved token.</span>
                <button disabled={busy || !token.trim()} className="btn lw-settings-start">{busy ? 'Connecting…' : 'Connect with token'}</button>
              </form>
            </details>
          </>}
        </section>
      </div>
    </main>
  )
}
