import { ChevronDown, ExternalLink, Search } from '../ui/icon'
import { useState } from 'react'

import { describeRecord, displayName, errorText, formatSize, licenseLabel, originShort, removeSkill, shortPath, type SkillRecord, type SkillsFolder } from '../../lib/library/skillStore'
import { SectionHead } from '../ui/SectionHead'
import { Glyph, NeedTags } from './SkillTags'
import { InlineMarkdown } from '../ui/Markdown'

/**
 * My skills: what is in LoomWatch's folder, which every agent can use. Each row opens to say
 * where it came from, its license and what it needs, and to change or remove it. A skill just
 * added glows for a moment, so you see where it went. New skill and Find skills in your apps sit
 * above the list, so a long list never hides them.
 */
export function Shelf({ folder, error, fresh, onRetry, onChanged, onBringIn, onNew, onChange }: {
  folder: SkillsFolder | null
  error: string
  fresh: ReadonlySet<string>
  onRetry: () => void
  onChanged: () => void
  onBringIn: () => void
  /** Write a new skill. */
  onNew: () => void
  /** Change the words of the skill in folder `name`. */
  onChange: (name: string) => void
}) {
  const [filter, setFilter] = useState('')
  const skills = folder?.skills ?? []
  const needle = filter.trim().toLowerCase()
  const shown = needle ? skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(needle)) : skills
  return (
    <section className="lw-skills-shelf" aria-label="My skills">
      <SectionHead as="h2" title="My skills" className="lw-skills-label" explain={<>Every agent can use the skills here. Apps such as Claude Code or Codex may have skills too: <b>Find skills in your apps</b> copies them in, and your apps keep theirs.</>}>
        {folder && <span className="lw-skills-count">{skills.length}</span>}
      </SectionHead>
      <div className="lw-skills-shelf-actions">
        <button type="button" className="btn" data-skill-new onClick={onNew}>New skill</button>
        <button type="button" className="btn" onClick={onBringIn}>Find skills in your apps</button>
      </div>
      {error && <div className="home-empty alert lw-skills-shelf-error"><span role="alert">{error}</span><button type="button" className="btn" onClick={onRetry}>Try again</button></div>}
      {!folder && !error && <p role="status" className="lw-skills-quiet">Loading your skills…</p>}
      {folder && skills.length === 0 && <p className="lw-skills-empty">Nothing here yet. Skills you add show up here, and every agent can use them.</p>}
      {skills.length > 6 && <label className="lw-skills-filter"><Search size={14} aria-hidden="true" /><input value={filter} placeholder="Filter my skills" aria-label="Filter my skills" onChange={(event) => setFilter(event.target.value)} /></label>}
      {skills.length > 0 && <ul className="lw-skills-shelf-list" aria-label="My skills">
        {shown.map((skill) => <Item key={skill.name} skill={skill} fresh={fresh.has(skill.name)} onChanged={onChanged} onChange={() => onChange(skill.name)} />)}
      </ul>}
      {needle && shown.length === 0 && <p className="lw-skills-quiet">None of your skills match “{filter}”.</p>}
      {folder && <p className="lw-skills-where">Kept in <span title={folder.folder}>{shortPath(folder.folder)}</span></p>}
    </section>
  )
}

function Item({ skill, fresh, onChanged, onChange }: { skill: SkillRecord; fresh: boolean; onChanged: () => void; onChange: () => void }) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const name = displayName(skill.name)
  async function remove() {
    setBusy(true); setError('')
    try { await removeSkill(skill.name); onChanged() } catch (caught) { setError(errorText(caught)); setBusy(false) }
  }
  return (
    <li className={`lw-skills-item ${open ? 'open' : ''} ${fresh ? 'fresh' : ''}`}>
      <button type="button" className="lw-skills-item-row" aria-expanded={open} onClick={() => { setOpen(!open); setConfirming(false) }}>
        <Glyph name={skill.name} description={skill.description} size="sm" />
        <span className="lw-skills-item-name">
          <b>{name}</b>
          <span>{originShort(skill.origin)}{skill.changedAt && skill.origin.kind !== 'written' ? ', changed' : ''}</span>
        </span>
        <ChevronDown size={14} aria-hidden="true" className="lw-skills-chev" />
      </button>
      {open && <div className="lw-skills-item-more">
        {skill.description && <p><InlineMarkdown>{skill.description}</InlineMarkdown></p>}
        <NeedTags runtimes={skill.runtimes} needs={skill.needs} hasScripts={skill.hasScripts} />
        <dl className="lw-skills-facts">
          <dt>From</dt><dd>{describeRecord(skill)}{skill.origin.url && <>{' · '}<a className="link lw-skills-out" href={skill.origin.url} target="_blank" rel="noreferrer">Open its page<ExternalLink size={11} aria-hidden="true" /></a></>}</dd>
          {/* A skill you wrote is yours: a license says what others let you do with theirs. */}
          {skill.origin.kind !== 'written' && <><dt>License</dt><dd>{licenseLabel(skill.license).replace(/^License: /, '')}</dd></>}
          <dt>Size</dt><dd>{formatSize(skill.sizeBytes)}</dd>
          <dt>Folder</dt><dd className="lw-skills-mono">{skill.name}</dd>
        </dl>
        {error && <p role="alert" className="lw-skills-error">{error}</p>}
        {confirming
          ? <div className="lw-skills-confirm" role="group" aria-label={`Remove ${name}?`}>
            <span>Remove {name}? Your agents won’t have it any more. LoomWatch moves it to a removed folder rather than deleting it.</span>
            <span className="lw-skills-actions">
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove()}>{busy ? 'Removing…' : 'Remove'}</button>
              <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(false)}>Keep it</button>
            </span>
          </div>
          : <span className="lw-skills-item-actions">
            <button type="button" className="btn" data-skill-change={skill.name} aria-label={`Change ${name}`} onClick={onChange}>Change</button>
            <button type="button" className="link alert lw-skills-remove" onClick={() => setConfirming(true)}>Remove {name}</button>
          </span>}
      </div>}
    </li>
  )
}
