import { ArrowLeft } from 'lucide-react'
import { useEffect, useState } from 'react'

type Page = { id: string; title: string }
type Connection = { connected: boolean; name?: string; destination?: Page | null }
type Results = { pages: Page[]; nextCursor: string | null }

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
  const [connection, setConnection] = useState<Connection | null>(null)
  const [token, setToken] = useState('')
  const [query, setQuery] = useState('')
  const [searchedQuery, setSearchedQuery] = useState('')
  const [results, setResults] = useState<Results | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let active = true
    request<Connection>('connection').then((value) => { if (active) setConnection(value) })
      .catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : 'Could not load connections.') })
    return () => { active = false }
  }, [])

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

  return (
    <main className="lw-settings">
      <div className="lw-settings-column">
        <a href="/" className="link lw-settings-back"><ArrowLeft size={14} aria-hidden="true" /> Back to the canvas</a>
        <div className="lw-settings-head">
          <h1 className="t-display">Connections</h1>
          <p className="t-body">Connect your tools and choose where your work belongs.</p>
        </div>
        <section className="e1 lw-settings-section" aria-labelledby="notion-heading" aria-busy={busy}>
          <h2 id="notion-heading" className="t-title">Notion</h2>
          {error && <p role="alert" className="inline-error t-body"><span className="detail">{error}</span></p>}
          {notice && <p role="status" className="lw-notice t-meta">{notice}</p>}
          {!connection && !error && <p role="status" className="t-meta lw-settings-quiet">Loading connection…</p>}
          {!connection && error && <button type="button" className="btn lw-settings-start" disabled={busy} onClick={() => void act(async () => setConnection(await request<Connection>('connection')))}>Retry</button>}
          {connection?.connected ? <>
            <p className="t-body">Connected to <strong>{connection.name}</strong></p>
            <p className="t-meta lw-settings-quiet">Your token is stored in this Mac's Keychain. Disconnecting removes LoomWatch's saved credentials; existing Notion pages remain.</p>
            <div className="e2 lw-settings-row">
              <span className="t-body-m">Destination page</span>
              <span className="t-meta">{connection.destination ? connection.destination.title : 'Choose the page that will contain your digests.'}</span>
              <span className="t-meta lw-settings-quiet">This saves a destination. It does not start a pipeline or create a daily schedule.</span>
            </div>
            <form className="lw-settings-search" onSubmit={(event) => { event.preventDefault(); void act(() => search()) }}>
              <label className="field"><span className="t-meta">Find a page</span><input className="input" value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} placeholder="Search by title, or leave blank" /></label>
              <button className="btn btn-primary" disabled={busy}>Search</button>
            </form>
            {results && <div className="lw-settings-results">
              {results.pages.length === 0 && <p className="t-meta lw-settings-quiet">No pages found. In Notion, open your page → ••• → Connections and add your integration, then search again.</p>}
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
            <p className="t-body lw-settings-quiet">Use a Notion integration token to connect your workspace on this Mac.</p>
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
              <button disabled={busy || !token.trim()} className="btn btn-primary lw-settings-start">{busy ? 'Connecting…' : 'Connect Notion'}</button>
            </form>
          </>}
        </section>
      </div>
    </main>
  )
}
