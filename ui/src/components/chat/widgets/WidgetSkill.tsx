import { useState } from 'react'
import { createPortal } from 'react-dom'

import { errorText, saveSkillWords, SkillsApiError } from '../../../lib/library/skillStore'
import { shownName, skillName } from '../../../lib/library/skillName'
import type { KeptWidget, WidgetSpec, WidgetState } from '../../../lib/widgets/types'
import { useHeldState } from '../../../lib/widgets/useHeldState'
import { SkillSheet } from '../../skills/SkillSheet'
import { Glyph } from '../../skills/SkillTags'
import { Markdown } from '../../ui/Markdown'

type Skill = Extract<WidgetSpec, { kind: 'skill' }>

/**
 * A skill the agent suggests under its answer (ADR 0118): its name and when to use it, what it
 * says one tap away, and Save, Change or Not now. Save puts it in LoomWatch's skills, where every
 * agent can use it; Change opens it on the Skills page's own sheet first. Nothing is saved until
 * the person does one of those, and what they did is kept, so the agent's next work knows.
 */
export function WidgetSkill({ kept, onChange, live, by }: {
  kept: KeptWidget
  onChange: (n: number, state: WidgetState) => Promise<KeptWidget>
  live: boolean
  /** The agent that suggested it, as the chat names them. */
  by?: string
}) {
  const held = useHeldState(kept, onChange)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [writing, setWriting] = useState(false)
  // A skill left with Not now can be looked at again here, without changing what was kept.
  const [again, setAgain] = useState(false)
  if (kept.spec.kind !== 'skill') return null
  const spec: Skill = kept.spec
  // As it will show once saved, so the skill never goes by two names.
  const title = shownName(spec.title)
  const state = held.state
  const saved = state && 'saved' in state ? state.saved : null
  const left = Boolean(state && 'dismissed' in state) && !again

  async function save() {
    setBusy(true); setError('')
    try {
      const written = await saveSkillWords({ name: skillName(spec.title), description: spec.description, instructions: spec.instructions, ...(by ? { suggestedBy: by } : {}) })
      held.keep({ saved: written.skill.name })
    } catch (caught) {
      // The daemon names the folder; the card has no name box, so say where to change the name.
      setError(caught instanceof SkillsApiError && caught.status === 409
        ? `You already have a skill called “${title}”. Choose Change to give this one another name.`
        : errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  if (left) {
    return (
      <section className="wg wg-skill left" aria-label={`Skill you didn’t save: ${title}`}>
        <p className="wg-skill-left">You didn’t save “{title}”. <button type="button" className="link" onClick={() => setAgain(true)}>Show it</button></p>
      </section>
    )
  }
  return (
    <section className="wg wg-skill" aria-label={`Suggested skill: ${title}`}>
      <div className="wg-skill-head">
        <Glyph name={skillName(spec.title)} description={spec.description} />
        <div className="wg-skill-name">
          <p className="wg-title">{title}</p>
          <p className="wg-skill-when">{spec.description}</p>
        </div>
      </div>
      <details className="wg-skill-says">
        <summary>What it says</summary>
        <div className="lw-skills-recipe-text"><Markdown>{spec.instructions}</Markdown></div>
      </details>
      {saved
        ? <p className="wg-skill-saved" role="status">Saved. Every agent can use it now.</p>
        : <div className="wg-skill-actions">
          <button type="button" className="btn btn-ring" disabled={busy || live} onClick={() => void save()}>{busy ? 'Saving…' : 'Save skill'}</button>
          <button type="button" className="btn" disabled={busy || live} onClick={() => setWriting(true)}>Change</button>
          <button type="button" className="link" disabled={busy || live} onClick={() => { setAgain(false); if (!(state && 'dismissed' in state)) held.keep({ dismissed: true }) }}>Not now</button>
        </div>}
      {(error || held.error) && <p role="alert" className="wg-skill-error">{error || held.error}</p>}
      {writing && createPortal(
        <SkillSheet
          writing={{ kind: 'new', start: { title: spec.title, description: spec.description, instructions: spec.instructions }, ...(by ? { suggestedBy: by } : {}) }}
          onClose={() => setWriting(false)}
          onSaved={(written) => { setWriting(false); setError(''); held.keep({ saved: written.skill.name }) }}
        />,
        document.body,
      )}
    </section>
  )
}
