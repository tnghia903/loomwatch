import { useEffect, useId, useState } from 'react'

import { type AboutYou as Told, MAX_ABOUT_CHARS, MAX_NAME_CHARS, announceYou, fetchYou, saveYou, toldNothing } from '../../lib/you/client'

const count = (value: number) => value.toLocaleString('en-US')

/**
 * What the person tells their agents about themselves (ADR 0074): a name, and a few lines about
 * who they are and how they like answers. Every agent reads it at the start of its work, so its
 * answer fits them.
 *
 * `variant="card"` is the short form Home offers once, after the OpenRouter key: Save, or Not now.
 * `onDone` hears what is kept after either.
 */
export function AboutYou({ variant = 'section', onDone }: { variant?: 'section' | 'card'; onDone?: (you: Told) => void }) {
  const [saved, setSaved] = useState<Told | null>(null)
  const [name, setName] = useState('')
  const [about, setAbout] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const headingId = useId()
  const nameId = useId()
  const aboutId = useId()
  const aboutHintId = useId()

  useEffect(() => {
    let active = true
    fetchYou()
      .then((value) => {
        announceYou(value)
        if (!active) return
        setSaved(value)
        setName(value.name ?? '')
        setAbout(value.about ?? '')
      })
      .catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : 'Couldn’t load what your agents know about you.') })
    return () => { active = false }
  }, [])

  async function keep(next: Told, done: string) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const value = await saveYou(next)
      setSaved(value)
      setName(value.name ?? '')
      setAbout(value.about ?? '')
      announceYou(value)
      setNotice(done)
      onDone?.(value)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const card = variant === 'card'
  const changed = saved !== null && (name.trim() !== (saved.name ?? '') || about.trim() !== (saved.about ?? ''))
  const empty = !name.trim() && !about.trim()
  const heading = <h2 id={headingId} className="t-title">{card ? 'Tell your agents about you' : 'What your agents know about you'}</h2>

  return (
    <section className={card ? 'e1 lw-settings-section lw-you-card' : 'e1 lw-settings-section'} aria-labelledby={headingId} aria-busy={busy}>
      {heading}
      {error && <p role="alert" className="inline-error t-body"><span className="detail">{error}</span></p>}
      {notice && <p role="status" className="lw-notice t-meta">{notice}</p>}
      {!saved && !error && <p role="status" className="t-meta lw-settings-quiet">Loading…</p>}
      {saved && <>
        <p className="t-body">{card
          ? 'So their answers fit you. You can change this any time in About you.'
          : 'Every agent reads this before it starts work, so its answers fit you: your language, your work, how much detail you like.'}</p>
        <form className="lw-you-form" onSubmit={(event) => {
          event.preventDefault()
          void keep({ name, about, skipped: saved.skipped }, 'Saved. Your agents read this from their next piece of work.')
        }}>
          <div className="field">
            <label className="t-meta" htmlFor={nameId}>What should your agents call you?</label>
            <input id={nameId} className="input" autoComplete="given-name" value={name} maxLength={MAX_NAME_CHARS} placeholder="Your name" onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="field">
            <label className="t-meta" htmlFor={aboutId}>What should they know about you?</label>
            <textarea id={aboutId} className="input" rows={card ? 3 : 5} value={about} maxLength={MAX_ABOUT_CHARS} aria-describedby={aboutHintId}
              placeholder="For example: I teach English at a primary school. Answer in Vietnamese, and keep it short."
              onChange={(event) => setAbout(event.target.value)} />
            <span id={aboutHintId} className="hint t-meta lw-you-hint">
              <span>What you do, the language you want answers in, how long or detailed you like them, what you’re working on.</span>
              <span className="lw-you-count" aria-label={`${count(about.length)} of ${count(MAX_ABOUT_CHARS)} characters`}>{count(about.length)} / {count(MAX_ABOUT_CHARS)}</span>
            </span>
          </div>
          <p className="t-meta lw-settings-quiet">Kept on this computer. Your agents read it with every task, so it goes to OpenRouter with their work. Leave out passwords and anything private.</p>
          <div className="lw-settings-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || empty || (!card && !changed)}>{busy ? 'Saving…' : 'Save'}</button>
            {card && <button type="button" className="btn" disabled={busy} onClick={() => void keep({ skipped: true }, '')}>Not now</button>}
            {!card && !toldNothing(saved) && <button type="button" className="link alert" disabled={busy}
              onClick={() => void keep({ skipped: true }, 'Cleared. Your agents no longer know your name or anything about you.')}>Clear</button>}
          </div>
        </form>
      </>}
    </section>
  )
}
