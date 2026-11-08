import { ExternalLink, Plus } from '../ui/icon'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { fetchCapabilityDetails, type CapabilityDetails, type DetectedCapability } from '../../lib/library/client'
import { describeRecord, displayName, errorText, fetchSkills, formatSize, licenseLabel, shortPath, skillBody, type SkillRecord } from '../../lib/library/skillStore'
import { InlineMarkdown, Markdown } from '../ui/Markdown'
import { Sheet } from './Sheet'
import { SkillSheet } from './SkillSheet'
import { Glyph, NeedTags } from './SkillTags'

type Read = { details: CapabilityDetails | null; record: SkillRecord | null; error: string }

/**
 * One skill, opened from an agent's Skills block: what it is for, where it came from, what it
 * needs, and every word of its instructions, so you can tell what pinning it up would give the
 * agent before you do. The instructions are the copy a run would deliver (the first definition).
 *
 * Laid over the page in the Skills page's sheet. Pinning it up or taking it down closes it. A skill
 * in LoomWatch's own folder can be changed from here, on the Skills page's own sheet (ADR 0118).
 */
export function SkillDetails({ item, pinned, onPin, onTakeDown, onClose }: {
  item: DetectedCapability
  /** On this agent's pegboard already. */
  pinned: boolean
  onPin: () => void
  onTakeDown: () => void
  onClose: () => void
}) {
  const [read, setRead] = useState<Read | null>(null)
  const [turn, setTurn] = useState(0)
  const [changing, setChanging] = useState(false)
  // Saved from here: said here, since this sheet has no toast.
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    let active = true
    // Its record in LoomWatch's folder says where it came from and under what license. A
    // project's own skill has none, and the rest shows without it.
    const record = item.source.startsWith('LoomWatch')
      ? fetchSkills().then((folder) => folder.skills.find((skill) => skill.name === item.name) ?? null, () => null)
      : Promise.resolve(null)
    Promise.all([fetchCapabilityDetails(item.id), record]).then(
      ([details, found]) => { if (active) setRead({ details, record: found, error: '' }) },
      (caught: unknown) => { if (active) setRead({ details: null, record: null, error: errorText(caught) }) },
    )
    return () => { active = false }
  }, [item.id, item.name, item.source, turn])

  const definition = read?.details?.definitions[0]
  const record = read?.record ?? null
  const needs = read?.details?.portability?.needs ?? record?.needs ?? []
  const body = definition ? skillBody(definition.content) : ''
  const change = record && <button type="button" className="btn lw-skills-details-change" data-skill-change={record.name} onClick={() => setChanging(true)}>Change</button>
  const footer = pinned
    ? <>
      {change}
      <button type="button" className="btn" onClick={onTakeDown}>Take this skill away</button>
      <button type="button" className="btn btn-primary" onClick={onClose}>Close</button>
    </>
    : <>
      {change}
      <button type="button" className="btn" onClick={onClose}>Close</button>
      <button type="button" className="btn btn-primary" onClick={onPin}><Plus size={14} aria-hidden="true" />Give it this skill</button>
    </>

  if (changing && record) {
    return createPortal(
      <SkillSheet writing={{ kind: 'change', name: record.name }} onClose={() => setChanging(false)}
        onSaved={() => { setChanging(false); setSaved(true); setRead(null); setTurn((value) => value + 1) }} />,
      document.body,
    )
  }
  return createPortal(
    <Sheet kicker={`Skill · ${item.source}`} title={displayName(item.name)} onClose={onClose} footer={footer} returnFocus={`[data-skill=${JSON.stringify(item.name)}]`}>
      <div className="lw-skills-intro">
        <Glyph name={item.name} description={item.detail} size="lg" />
        <div>
          {item.detail && <p className="lw-skills-intro-desc"><InlineMarkdown>{item.detail}</InlineMarkdown></p>}
          <p className="lw-skills-quiet">{pinned ? 'This agent has it, and opens it when the work calls for it.' : 'It opens a skill only when the work calls for it.'}</p>
          {saved && <p className="lw-skills-quiet" role="status">Saved. Your agents use the new words from now on.</p>}
        </div>
      </div>
      <NeedTags runtimes={record?.runtimes ?? []} needs={needs} hasScripts={record?.hasScripts ?? false} />
      <dl className="lw-skills-facts">
        <dt>From</dt>
        <dd>{record ? describeRecord(record) : item.source}{record?.origin.url && <>{' · '}<a className="link lw-skills-out" href={record.origin.url} target="_blank" rel="noreferrer">Open its page<ExternalLink size={11} aria-hidden="true" /></a></>}</dd>
        {record && record.origin.kind !== 'written' && <><dt>License</dt><dd>{licenseLabel(record.license).replace(/^License: /, '')}</dd></>}
        {record && <><dt>Size</dt><dd>{formatSize(record.sizeBytes)}</dd></>}
        {definition && <><dt>File</dt><dd className="lw-skills-mono" title={definition.path}>{shortPath(definition.path)}</dd></>}
      </dl>
      <section className="lw-skills-recipe" aria-label="What it says">
        <h3 className="lw-skills-label">What it says</h3>
        {!read && <div className="capability-definition-loading" role="status"><span className="skel-bar" /><span className="skel-bar" /><span className="skel-bar" /><span className="visually-hidden">Reading the skill…</span></div>}
        {read?.error && (
          <div className="inline-error" role="alert">
            <span className="msg t-body">Couldn’t read this skill.</span>
            <span className="detail t-meta">{read.error}</span>
            <span><button type="button" className="btn" onClick={() => { setRead(null); setTurn((value) => value + 1) }}>Try again</button></span>
          </div>
        )}
        {read?.details && !body && <p className="lw-skills-quiet">{definition ? 'Its SKILL.md holds nothing past its name and description.' : 'LoomWatch found no SKILL.md to read for it.'}</p>}
        {body && <div className="lw-skills-recipe-text"><Markdown>{body}</Markdown></div>}
      </section>
    </Sheet>,
    document.body,
  )
}
