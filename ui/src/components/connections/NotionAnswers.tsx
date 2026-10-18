import { useEffect, useId, useState } from 'react'

import {
  chooseNotionDestination, fetchNotionConnection, searchNotionPages,
  type NotionConnection, type NotionPageHit,
} from '../../lib/notion/connection'

interface NotionAnswersProps {
  /** Open the page list straight away: Notion was just connected, or a "Choose a page" sent you here. */
  choosing?: boolean
}

/**
 * The Notion tool's other job (ADR 0070): its sign-in also sends teams' answers to a Notion page,
 * and reads the pages agents are given. This is where that page is chosen, on the Notion tool's
 * own card, so Notion is connected once and changed in one place.
 */
export function NotionAnswers({ choosing: chooseNow = false }: NotionAnswersProps) {
  const ids = useId()
  const [connection, setConnection] = useState<NotionConnection>({ state: 'loading' })
  const [choosing, setChoosing] = useState(chooseNow)
  const [askedToChoose, setAskedToChoose] = useState(chooseNow)
  const [query, setQuery] = useState('')
  const [pages, setPages] = useState<NotionPageHit[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let active = true
    void fetchNotionConnection().then((value) => { if (active) setConnection(value) })
    return () => { active = false }
  }, [])
  // Asked to choose after it showed (Notion was just connected): the list opens then too.
  if (chooseNow !== askedToChoose) {
    setAskedToChoose(chooseNow)
    if (chooseNow) setChoosing(true)
  }

  async function act(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await work() } catch (caught) { setError(caught instanceof Error ? caught.message : 'That didn’t work. Try again.') }
    finally { setBusy(false) }
  }
  const search = (text: string) => act(async () => { setPages((await searchNotionPages(text)).pages) })

  // The list opens on recent pages, so choosing one is the next click.
  useEffect(() => {
    if (choosing && pages === null) void search('')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once each time the list opens
  }, [choosing])

  const destination = connection.state === 'connected' ? connection.destination : null
  return (
    <section className="notion-answers" aria-labelledby={`${ids}-title`} aria-busy={busy}>
      <h3 id={`${ids}-title`}>Teams’ answers</h3>
      <p className="t-meta" role="status">{connection.state === 'loading'
        ? 'Checking where answers go…'
        : connection.state === 'unavailable'
          ? connection.message
          : destination
            ? <>New pages go under <strong>{destination.title}</strong>.</>
            : 'Choose the page your teams’ answers go under.'}</p>
      <p className="t-meta notion-answers-quiet">To send a team’s answers there, select its <strong>Team response</strong> on the canvas and turn on <strong>Send every answer to Notion</strong>. To give an agent a page to read, drag <strong>Notion</strong> from <strong>Connections</strong> in a team’s side panel onto the agent. LoomWatch does both with this sign-in; agents never get it.</p>
      {error && <p role="alert" className="inline-error t-meta"><span className="detail">{error}</span></p>}
      {notice && <p role="status" className="lw-notice t-meta">{notice}</p>}
      {!choosing
        ? connection.state === 'connected' && <button type="button" className="link lw-settings-start" onClick={() => setChoosing(true)}>{destination ? 'Change the page' : 'Choose a page'}</button>
        : <>
          <form className="lw-settings-search" onSubmit={(event) => { event.preventDefault(); void search(query) }}>
            <label className="field"><span className="t-meta">Find a page</span><input className="input" value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} placeholder="Search by title, or leave blank" /></label>
            <button className="btn" disabled={busy}>Search</button>
          </form>
          {pages && <div className="lw-settings-results">
            {pages.length === 0 && <p className="t-meta notion-answers-quiet">No pages found. Try another word, or leave the search blank to see recent pages.</p>}
            <ul className="pop-list" aria-label="Notion pages">
              {pages.map((page) => <li key={page.id}><button type="button" disabled={busy} className={`pop-row ${page.id === destination?.id ? 'current' : ''}`} onClick={() => void act(async () => {
                setConnection(await chooseNotionDestination(page.id)); setChoosing(false); setNotice(`Answers go under ${page.title} now.`)
              })}><span className="name t-body">{page.title}</span>{page.id === destination?.id && <span className="aside t-meta">Selected</span>}</button></li>)}
            </ul>
          </div>}
          <button type="button" className="link lw-settings-start" disabled={busy} onClick={() => setChoosing(false)}>Done</button>
        </>}
    </section>
  )
}
