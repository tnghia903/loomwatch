import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'

import {
  describeRecord, displayName, draftSkill, errorText, fetchSkills, readSkillWords, saveSkillWords, SkillsApiError,
  type SkillDraft, type SkillRecord, type SkillWords, type WrittenSkill,
} from '../../lib/library/skillStore'
import { shownName, skillName } from '../../lib/library/skillName'
import { wordDiff } from '../../lib/wordDiff'
import { Sheet } from './Sheet'
import { Notices } from './SkillTags'

/** The longest description a skill may have, as the Agent Skills format allows. */
const DESCRIPTION_CHARS = 1024

/** What the sheet writes: a new skill, perhaps one an agent suggested, or a change to one here,
    perhaps one proposed elsewhere (Ask), which opens shown as a change with Put back. A proposal's
    `base` names the `SKILL.md` it was made from: when the skill changed since, it opens as it is
    saved now and says so, since the proposal's edits were made to other words. */
export type Writing =
  | { kind: 'new'; start?: SkillDraft; suggestedBy?: string }
  | { kind: 'change'; name: string; proposed?: Pick<SkillDraft, 'description' | 'instructions'> & { base?: string } }

type Fields = { title: string; description: string; instructions: string }
type Words = Pick<Fields, 'description' | 'instructions'>

const EMPTY: Fields = { title: '', description: '', instructions: '' }

/**
 * Writing a skill, or changing one, on one sheet (ADR 0118). Its first box takes what the person
 * wants in their own words: LoomWatch's own model writes the skill from them, or makes the change
 * they ask for, and the sheet shows what it took out and put in, with Put back. Below are the
 * skill's own words, to write or change by hand: its name, when to use it, which is all an agent
 * sees before it opens a skill, and what to do. Nothing is saved until Save.
 */
export function SkillSheet({ writing, onClose, onSaved, returnFocus }: {
  writing: Writing
  onClose: () => void
  onSaved: (written: WrittenSkill, kind: Writing['kind']) => void
  /** Where focus goes when what opened the sheet is gone; the Skills page's own controls otherwise. */
  returnFocus?: string
}) {
  const changing = writing.kind === 'change' ? writing.name : null
  const proposed = writing.kind === 'change' ? writing.proposed : undefined
  const [words, setWords] = useState<SkillWords | null>(null)
  const [record, setRecord] = useState<SkillRecord | null>(null)
  const [readError, setReadError] = useState<{ text: string; again: boolean } | null>(null)
  const [readTurn, setReadTurn] = useState(0)
  // A proposal made from words the skill no longer has: it opens as it is saved now instead.
  const [outdated, setOutdated] = useState(false)
  // A change proposed elsewhere, shown as it opened: closing without touching it loses nothing,
  // since the card it came from still has it.
  const [proposal, setProposal] = useState<Words | null>(null)
  // What it opened with: nothing, or the skill an agent suggested.
  const [opened] = useState<Fields>(() => (writing.kind === 'new' && writing.start ? { ...EMPTY, ...writing.start, title: shownName(writing.start.title ?? '') } : EMPTY))
  const [fields, setFields] = useState<Fields>(opened)
  const [ask, setAsk] = useState('')
  const [asking, setAsking] = useState(false)
  const [askError, setAskError] = useState('')
  // The words before LoomWatch's last change, for what it changed and Put back.
  const [before, setBefore] = useState<Words | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [leaving, setLeaving] = useState(false)
  const askTurn = useRef(0)
  const ids = { ask: useId(), title: useId(), description: useId(), instructions: useId(), hint: useId() }

  useEffect(() => {
    if (!changing) return
    let active = true
    Promise.all([readSkillWords(changing), fetchSkills().then((folder) => folder.skills.find((skill) => skill.name === changing) ?? null, () => null)]).then(
      ([read, found]) => {
        if (!active) return
        setWords(read); setRecord(found)
        const had = { description: read.description, instructions: read.instructions }
        // A change proposed elsewhere shows as one: what it takes out and puts in, with Put back.
        const stale = Boolean(proposed?.base) && proposed?.base !== read.base
        const shown = proposed && !stale ? { description: proposed.description, instructions: proposed.instructions } : null
        setFields({ title: '', ...(shown ?? had) })
        setBefore(shown ? had : null)
        setProposal(shown)
        setOutdated(stale)
      },
      // A skill LoomWatch won't change (422) can't be helped by trying again.
      (caught: unknown) => { if (active) setReadError({ text: errorText(caught), again: !(caught instanceof SkillsApiError && caught.status === 422) }) },
    )
    return () => { active = false }
    // A proposal is what the sheet opens with, not something it follows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changing, readTurn])

  const ready = !changing || words !== null
  const name = changing ?? skillName(fields.title)
  const empty = !fields.description.trim() && !fields.instructions.trim()
  // Changed from what it opened with: only then is there something to save.
  const dirty = changing
    ? words !== null && (fields.description.trim() !== words.description || fields.instructions.trim() !== words.instructions)
    : (['title', 'description', 'instructions'] as const).some((key) => fields[key].trim() !== opened[key].trim())
  // What leaving would lose: a change, or words typed in the top box and not yet used. A proposal
  // as it opened is kept where it came from.
  const asProposed = proposal !== null && fields.description.trim() === proposal.description.trim() && fields.instructions.trim() === proposal.instructions.trim()
  const unsaved = (dirty && !asProposed) || Boolean(ask.trim())
  const missing = !name ? 'Give it a name with letters or numbers in it.'
    : !fields.description.trim() ? 'Say when your agents should use it.'
      : !fields.instructions.trim() ? 'Say what your agents should do.' : ''
  const busy = asking || saving
  const writesNew = !changing && empty
  // Something to save is there: what's still missing is worth saying.
  const started = changing ? dirty : !empty || Boolean(fields.title.trim())

  async function askFor() {
    const said = ask.trim()
    if (!said || asking) return
    const turn = ++askTurn.current
    setAsking(true); setAskError('')
    const now: Words = { description: fields.description, instructions: fields.instructions }
    try {
      const draft = await draftSkill(said, writesNew ? undefined : now)
      if (turn !== askTurn.current) return
      setFields((current) => ({
        title: current.title.trim() || changing ? current.title : shownName(draft.title ?? ''),
        description: draft.description,
        instructions: draft.instructions,
      }))
      // A new skill written from nothing has nothing to compare; a change keeps what it had.
      setBefore(writesNew ? null : (before ?? now))
      setAsk('')
    } catch (caught) {
      if (turn === askTurn.current) setAskError(errorText(caught))
    } finally {
      if (turn === askTurn.current) setAsking(false)
    }
  }

  async function save() {
    if (missing || busy) return
    setSaving(true); setSaveError('')
    try {
      const written = await saveSkillWords({
        name,
        description: fields.description,
        instructions: fields.instructions,
        ...(words ? { base: words.base } : {}),
        ...(writing.kind === 'new' && writing.suggestedBy ? { suggestedBy: writing.suggestedBy } : {}),
      })
      onSaved(written, writing.kind)
    } catch (caught) {
      // The daemon names the folder; say it as the person named it.
      const conflict = caught instanceof SkillsApiError && caught.status === 409
      setSaveError(!conflict ? errorText(caught)
        : changing ? `“${displayName(changing)}” changed since you opened it. Close it and open it again to see the change.`
          : `You already have a skill called “${shownName(fields.title)}”. Give this one another name.`)
      setSaving(false)
    }
  }

  const close = () => {
    if (busy) return
    if (unsaved && !leaving) { setLeaving(true); return }
    askTurn.current += 1
    onClose()
  }
  const onAskKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void askFor() }
  }
  const set = (key: keyof Fields) => (value: string) => { setFields((current) => ({ ...current, [key]: value })); setLeaving(false) }
  const changed = (key: keyof Words) => before !== null && before[key].trim() !== fields[key].trim()
  // A change proposed elsewhere opens with what it takes out and puts in first: the person asked for
  // it already, so the box for more comes after it.
  const opensMarked = proposal !== null && before !== null
  const marked = before && (changed('description') || changed('instructions')) && (
    <section className="instructions-updated" aria-label="What LoomWatch changed">
      <p>Taken out <del>like this</del>, put in <ins>like this</ins>:</p>
      {(['description', 'instructions'] as const).filter(changed).map((key, _, both) => (
        <p key={key} className="instructions-diff">{both.length > 1 && <span className="lw-skills-quiet">{key === 'description' ? 'When to use it: ' : 'What to do: '}</span>}{wordDiff(before[key], fields[key]).map((part, index) =>
          part.kind === 'removed' ? <del key={index}>{part.text}</del> : part.kind === 'added' ? <ins key={index}>{part.text}</ins> : <span key={index}>{part.text}</span>)}</p>
      ))}
      <div className="instructions-updated-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => { setFields((current) => ({ ...current, ...before })); setBefore(null) }}>Put back</button>
      </div>
    </section>
  )

  const footer = leaving
    ? <>
      <span className="lw-skills-foot-note">Leave without saving? What you wrote here will be lost.</span>
      <button type="button" className="btn" onClick={() => setLeaving(false)}>Keep writing</button>
      <button type="button" className="btn btn-danger" onClick={close}>Leave</button>
    </>
    : <>
      {saveError ? <span role="alert" className="lw-skills-foot-note lw-skills-error">{saveError}</span>
        : started && missing && <span className="lw-skills-foot-note">{missing}</span>}
      <button type="button" className="btn" disabled={busy} onClick={close}>Cancel</button>
      <button type="button" className="btn btn-primary" disabled={!ready || busy || Boolean(missing) || (changing !== null && !dirty)} onClick={() => void save()}>
        {saving ? 'Saving…' : 'Save skill'}
      </button>
    </>

  return (
    <Sheet
      kicker={changing ? (record ? describeRecord(record) : 'Skill') : writing.kind === 'new' && writing.suggestedBy ? `Suggested by ${writing.suggestedBy}` : 'Skill'}
      title={changing ? displayName(changing) : 'New skill'}
      busy={busy}
      onClose={close}
      footer={ready ? footer : <button type="button" className="btn" onClick={onClose}>Close</button>}
      returnFocus={returnFocus ?? (changing ? `[data-skill-change=${JSON.stringify(changing)}]` : '[data-skill-new]')}
    >
      {readError && (
        <div className="inline-error" role="alert">
          <span className="msg t-body">Couldn’t open this skill.</span>
          <span className="detail t-meta">{readError.text}</span>
          {readError.again && <span><button type="button" className="btn" onClick={() => { setReadError(null); setReadTurn((value) => value + 1) }}>Try again</button></span>}
        </div>
      )}
      {!ready && !readError && <div className="capability-definition-loading" role="status"><span className="skel-bar" /><span className="skel-bar" /><span className="visually-hidden">Opening the skill…</span></div>}
      {ready && <>
        {outdated && <Notices notices={[{ tone: 'note', text: 'This skill was changed after Ask read it, so Ask’s change isn’t shown. Ask again for a new change.' }]} />}
        {opensMarked && marked}
        <div className="lw-skill-ask">
          <label htmlFor={ids.ask}>{writesNew ? 'What should your agents know how to do?' : opensMarked ? 'Anything else to change?' : 'What should change?'}</label>
          <textarea
            id={ids.ask}
            className="input"
            rows={writesNew ? 3 : 2}
            value={ask}
            disabled={asking}
            placeholder={writesNew ? 'For example: write my weekly update for a client in three short bullets, warm, signed Mai.' : 'For example: keep it under 100 words.'}
            onChange={(event) => setAsk(event.target.value)}
            onKeyDown={onAskKey}
          />
          <div className="lw-skill-ask-row">
            {asking && <span className="lw-skills-quiet" role="status">{writesNew ? 'Writing it…' : 'Making the change…'}</span>}
            <button type="button" className="btn" disabled={!ask.trim() || asking || saving} onClick={() => void askFor()}>{writesNew ? 'Write it' : 'Change it'}</button>
          </div>
          {askError && <p role="alert" className="inline-error"><span className="detail">{askError}</span></p>}
        </div>
        {!opensMarked && marked}
        {!changing && <div className="field lw-skill-field">
          <label htmlFor={ids.title}>Name</label>
          <input id={ids.title} className="input" value={fields.title} maxLength={80} placeholder="For example: Weekly client update" disabled={busy}
            onChange={(event) => set('title')(event.target.value)}
            // It shows as it will everywhere once saved.
            onBlur={() => { if (fields.title.trim()) set('title')(shownName(fields.title)) }} />
        </div>}
        <div className="field lw-skill-field">
          <label htmlFor={ids.description}>When to use it</label>
          <textarea id={ids.description} aria-describedby={ids.hint} className={`input ${changed('description') ? 'instructions-marked' : ''}`} rows={3} maxLength={DESCRIPTION_CHARS} value={fields.description} disabled={busy}
            placeholder="For example: Writes the weekly update for a client. Use it when someone asks for a client update or a weekly summary."
            onChange={(event) => set('description')(event.target.value)} />
          <span id={ids.hint} className="lw-skills-quiet">Agents read only this to choose a skill.</span>
        </div>
        <div className="field lw-skill-field">
          <label htmlFor={ids.instructions}>What to do</label>
          <textarea id={ids.instructions} className={`input lw-skill-steps ${changed('instructions') ? 'instructions-marked' : ''}`} rows={12} value={fields.instructions} disabled={busy}
            placeholder={'For example:\n1. Read this week’s notes.\n2. Write three short bullets.\n3. Sign it Mai.'}
            onChange={(event) => set('instructions')(event.target.value)} />
        </div>
      </>}
    </Sheet>
  )
}
