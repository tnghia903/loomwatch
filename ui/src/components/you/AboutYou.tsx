import { Fragment, useEffect, useId, useState } from 'react'

import type { ModelSource } from '../../lib/ai/modelIds'
import { SOURCE_INFO, connectedSources } from '../../lib/ai/sources'
import { useAiStatus } from '../../lib/ai/useKeyStatus'
import { QUESTIONS, saidIn, withChoice, type QuickChoice, type QuickField } from '../../lib/firstrun/quickAbout'
import { type AboutYou as Told, MAX_ABOUT_CHARS, MAX_NAME_CHARS, announceYou, fetchYou, saveYou, toldNothing } from '../../lib/you/client'
import { AskAnotherAI } from './AskAnotherAI'
import { QuickChoices } from './QuickChoices'

const count = (value: number) => value.toLocaleString('en-US')

/**
 * Where what the person wrote goes: every service their agents can run on now (ADR 0073), named
 * the way they know it. Before anything is connected, or while that is still being asked, the AI in
 * general.
 */
function sentTo(sources: readonly ModelSource[]): string {
  const names = sources.map((source) => SOURCE_INFO[source].service)
  if (names.length === 0) return 'so it goes with their work to the AI they run on'
  if (names.length === 1) return `so it goes to ${names[0]} with their work`
  return `so it goes with their work to ${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}, whichever an agent runs on`
}

/**
 * What the person tells their agents about themselves (ADR 0074): a name, and a few lines about
 * who they are and how they like answers. Every agent reads it at the start of its work, so its
 * answer fits them. The first run's three questions (ADR 0075) sit above the text box: each choice
 * writes its sentence into the text, and shows what the text says, so the text stays the one
 * thing agents are told.
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
  // Something else before its words says nothing yet, so only this page knows it was picked.
  const [otherOpen, setOtherOpen] = useState(false)
  const [otherWork, setOtherWork] = useState('')
  const ai = useAiStatus()
  const headingId = useId()
  const nameId = useId()
  const aboutId = useId()
  const aboutHintId = useId()
  const otherId = useId()

  useEffect(() => {
    let active = true
    fetchYou()
      .then((value) => {
        announceYou(value)
        if (!active) return
        setSaved(value)
        setName(value.name ?? '')
        setAbout(value.about ?? '')
        setOtherWork(saidIn(value.about ?? '', 'work')?.otherWork ?? '')
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
      if (!value.about) { setOtherOpen(false); setOtherWork('') }
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
  const picked = <F extends QuickField>(field: F): QuickChoice<F> | null => {
    const said = saidIn(about, field)?.choice
    if (said) return said
    // Agents told nothing about length answer at the length they judge right.
    if (field === 'length') return 'Just right' as QuickChoice<F>
    return field === 'work' && otherOpen ? 'Something else' as QuickChoice<F> : null
  }
  const pick = <F extends QuickField>(field: F, choice: QuickChoice<F> | null) => {
    setAbout(withChoice(about, field, choice, choice === 'Something else' ? otherWork : ''))
    if (field !== 'work') return
    setOtherOpen(choice === 'Something else')
    if (choice !== 'Something else') setOtherWork('')
  }
  const writeAbout = (next: string) => {
    setAbout(next)
    setOtherWork(saidIn(next, 'work')?.otherWork ?? '')
  }
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
          : 'Every agent reads this before it starts work.'}</p>
        <form className="lw-you-form" onSubmit={(event) => {
          event.preventDefault()
          void keep({ name, about, skipped: saved.skipped }, 'Saved. Your agents read this from their next piece of work.')
        }}>
          <div className="field">
            <label className="t-meta" htmlFor={nameId}>What should your agents call you?</label>
            <input id={nameId} className="input" autoComplete="given-name" value={name} maxLength={MAX_NAME_CHARS} placeholder="Your name" onChange={(event) => setName(event.target.value)} />
          </div>
          {QUESTIONS.map(({ field, label }) => (
            <Fragment key={field}>
              <QuickChoices field={field} label={label} picked={picked(field)} onPick={(choice) => pick(field, choice)} />
              {field === 'work' && picked('work') === 'Something else' && (
                <div className="field">
                  <label className="t-meta" htmlFor={otherId}>In a few words</label>
                  <input id={otherId} className="input" maxLength={120} placeholder="For example: coffee farming" value={otherWork}
                    onChange={(event) => { setOtherWork(event.target.value); setAbout(withChoice(about, 'work', 'Something else', event.target.value)) }} />
                </div>
              )}
            </Fragment>
          ))}
          <div className="field">
            <label className="t-meta" htmlFor={aboutId}>What should your agents know about you?</label>
            <textarea id={aboutId} className="input" rows={card ? 3 : 5} value={about} maxLength={MAX_ABOUT_CHARS} aria-describedby={aboutHintId}
              placeholder="For example: I teach English to 8-year-olds, and I’m planning next term."
              onChange={(event) => writeAbout(event.target.value)} />
            <span id={aboutHintId} className="hint t-meta lw-you-hint">
              <span>Each choice above adds a line here. Add anything else, like what you’re working on.</span>
              <span className="lw-you-count" aria-label={`${count(about.length)} of ${count(MAX_ABOUT_CHARS)} characters`}>{count(about.length)} / {count(MAX_ABOUT_CHARS)}</span>
            </span>
          </div>
          {!card && <AskAnotherAI />}
          <p className="t-meta lw-settings-quiet">Kept on this computer. Your agents read it with every task, {sentTo(ai ? connectedSources(ai) : [])}. Leave out passwords and anything private.</p>
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
