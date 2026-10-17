import { ExternalLink } from 'lucide-react'
import { useState } from 'react'

import { describeOrigin, errorText, removeSkill, shortPath, type SkillRecord, type SkillsFolder } from '../../lib/library/skillStore'
import { SkillTags } from './SkillTags'

/**
 * Your skills: everything in LoomWatch's own skills folder, where each came from, its license and
 * what it needs. Remove asks once, then moves the skill out of the folder.
 */
export function YourSkills({ folder, error, onRetry, onChanged }: { folder: SkillsFolder | null; error: string; onRetry: () => void; onChanged: () => void }) {
  return (
    <section className="e1 lw-settings-section" aria-labelledby="skills-yours-heading">
      <h2 id="skills-yours-heading" className="t-title">Your skills</h2>
      {error && <>
        <p role="alert" className="inline-error t-body"><span className="detail">{error}</span></p>
        <button type="button" className="btn lw-settings-start" onClick={onRetry}>Try again</button>
      </>}
      {!folder && !error && <p role="status" className="t-meta lw-settings-quiet">Loading your skills…</p>}
      {folder && folder.skills.length === 0 && <p className="t-body lw-settings-quiet">No skills yet. Bring them in from your apps or install them below, and your agents can use them.</p>}
      {folder && folder.skills.length > 0 && <>
        <p className="t-body lw-settings-quiet">Your agents can use every skill here. LoomWatch keeps its own copy of each one.</p>
        <ul className="lw-skills-list" aria-label="Your skills">
          {folder.skills.map((skill) => <YourSkill key={skill.name} skill={skill} onChanged={onChanged} />)}
        </ul>
      </>}
      {folder && <p className="t-meta lw-settings-quiet">Kept in <span className="lw-skills-path">{shortPath(folder.folder)}</span></p>}
    </section>
  )
}

function YourSkill({ skill, onChanged }: { skill: SkillRecord; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function remove() {
    setBusy(true); setError('')
    try { await removeSkill(skill.name); onChanged() } catch (caught) { setError(errorText(caught)); setBusy(false) }
  }
  return (
    <li className="e2 lw-skills-item">
      <div className="lw-skills-item-head">
        <span className="t-body-m lw-skills-name">{skill.name}</span>
        {!confirming && <button type="button" className="link alert" aria-label={`Remove ${skill.name}`} onClick={() => setConfirming(true)}>Remove</button>}
      </div>
      {skill.description && <p className="t-meta lw-skills-desc">{skill.description}</p>}
      <p className="t-meta lw-settings-quiet">
        {describeOrigin(skill.origin)}
        {skill.origin.url && <>{' · '}<a className="link lw-skills-out" href={skill.origin.url} target="_blank" rel="noreferrer">Open its page<ExternalLink size={11} aria-hidden="true" /></a></>}
      </p>
      <SkillTags license={skill.license} runtimes={skill.runtimes} needs={skill.needs} hasScripts={skill.hasScripts} sizeBytes={skill.sizeBytes} />
      {error && <p role="alert" className="t-meta lw-skills-error">{error}</p>}
      {confirming && <div className="lw-skills-confirm" role="group" aria-label={`Remove ${skill.name}?`}>
        <span className="t-meta">Remove “{skill.name}”? Your agents won’t have it any more. LoomWatch moves it to a removed folder rather than deleting it.</span>
        <span className="lw-skills-actions">
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove()}>{busy ? 'Removing…' : 'Remove'}</button>
          <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(false)}>Keep it</button>
        </span>
      </div>}
    </li>
  )
}
