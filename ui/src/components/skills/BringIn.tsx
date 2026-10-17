import { Undo2 } from 'lucide-react'
import { useState } from 'react'

import { bringIn, errorText, previewBringIn, shortPath, skillCount, undoBringIn, type BringInCandidate, type BringInOutcome } from '../../lib/library/skillStore'
import { Locked, SkillTags, Tick } from './SkillTags'

/**
 * Bring in from your apps: look through the skill folders apps on this computer keep, tick the
 * skills to copy, then copy them. Nothing is looked at until the person asks. What came in can be
 * taken back with one Undo.
 */
export function BringIn({ onChanged }: { onChanged: () => void }) {
  const [candidates, setCandidates] = useState<BringInCandidate[] | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [outcome, setOutcome] = useState<BringInOutcome | null>(null)
  const [undone, setUndone] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function act(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError('')
    try { await work() } catch (caught) { setError(errorText(caught)) } finally { setBusy(false) }
  }
  const look = () => act(async () => {
    const found = await previewBringIn()
    setCandidates(found)
    setSelected(new Set(found.filter((candidate) => candidate.defaultSelected).map((candidate) => candidate.key)))
    setOutcome(null); setUndone(null)
  })
  const copy = () => act(async () => {
    const result = await bringIn([...selected])
    setOutcome(result); setCandidates(null)
    onChanged()
  })
  const undo = (batchId: string) => act(async () => {
    const removed = await undoBringIn(batchId)
    setUndone(removed.length); setOutcome(null)
    onChanged()
  })
  const toggle = (key: string) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  return (
    <section className="e1 lw-settings-section" aria-labelledby="skills-bring-in-heading" aria-busy={busy}>
      <h2 id="skills-bring-in-heading" className="t-title">Bring in from your apps</h2>
      <p className="t-body lw-settings-quiet">If apps on this computer, such as Claude Code or Codex, already have skills, LoomWatch can copy them so your agents can use them too. It only looks in those apps’ skill folders, and your apps keep their own copies.</p>
      {error && <p role="alert" className="inline-error t-body"><span className="detail">{error}</span></p>}

      {outcome && <div role="status" className="lw-skills-done">
        <p className="t-body">{outcome.imported.length > 0 ? `Brought in ${skillCount(outcome.imported.length)}.` : 'No skills were brought in.'}</p>
        {outcome.skipped.length > 0 && <>
          <p className="t-meta lw-settings-quiet">Left out:</p>
          <ul className="lw-skills-skipped t-meta">{outcome.skipped.map((skip) => <li key={skip.name}><b>{skip.name}</b>: {skip.reason}</li>)}</ul>
        </>}
        {outcome.imported.length > 0 && <button type="button" className="btn lw-settings-start" disabled={busy} onClick={() => void undo(outcome.batchId)}><Undo2 size={14} aria-hidden="true" />Undo</button>}
      </div>}
      {undone !== null && <p role="status" className="t-body">Took back {skillCount(undone)}.</p>}

      {!candidates && <button type="button" className="btn btn-primary lw-settings-start" disabled={busy} onClick={() => void look()}>{busy && !outcome ? 'Looking…' : outcome || undone !== null ? 'Look again' : 'Look for skills'}</button>}

      {candidates && candidates.length === 0 && <>
        <p className="t-body lw-settings-quiet">LoomWatch didn’t find skills in your apps’ folders.</p>
        <button type="button" className="btn lw-settings-start" disabled={busy} onClick={() => void look()}>Look again</button>
      </>}
      {candidates && candidates.length > 0 && <>
        <p className="t-meta lw-settings-quiet">Found {skillCount(candidates.length)}. The ticked ones will be copied into LoomWatch.</p>
        <ul className="lw-skills-list" aria-label="Skills in your apps">
          {candidates.map((candidate) => <Candidate key={candidate.key} candidate={candidate} checked={selected.has(candidate.key)} onToggle={() => toggle(candidate.key)} />)}
        </ul>
        <span className="lw-skills-actions">
          <button type="button" className="btn btn-primary" disabled={busy || selected.size === 0} onClick={() => void copy()}>{busy ? 'Bringing in…' : `Bring in ${skillCount(selected.size)}`}</button>
          <button type="button" className="btn" disabled={busy} onClick={() => setCandidates(null)}>Cancel</button>
        </span>
      </>}
    </section>
  )
}

function Candidate({ candidate, checked, onToggle }: { candidate: BringInCandidate; checked: boolean; onToggle: () => void }) {
  const locked = candidate.reason ?? (candidate.alreadyInLoomWatch ? 'Already in LoomWatch.' : undefined)
  return (
    <li className={`lw-skills-row ${locked ? 'locked' : ''}`}>
      <Tick checked={checked && !locked} disabled={locked !== undefined} onToggle={onToggle}>
        <b className="t-body">{candidate.name}</b>
        <span className="t-meta">From {candidate.app}{candidate.plugin ? `, ${candidate.plugin} plugin` : ''}</span>
      </Tick>
      <div className="lw-skills-row-body">
        {candidate.description && <p className="t-meta lw-skills-desc">{candidate.description}</p>}
        <SkillTags license={candidate.license} runtimes={candidate.runtimes} needs={candidate.needs} hasScripts={candidate.hasScripts} sizeBytes={candidate.sizeBytes} />
        <p className="t-meta lw-settings-quiet lw-skills-path" title={candidate.path}>{shortPath(candidate.path)}</p>
        {locked && <Locked>{locked}</Locked>}
      </div>
    </li>
  )
}
