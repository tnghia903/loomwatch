import { Check, Undo2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import {
  bringIn, displayName, errorText, licenseLabel, previewBringIn, RUNTIME_LABEL, shortPath, skillCount, undoBringIn,
  type BringInCandidate, type BringInOutcome,
} from '../../lib/library/skillStore'
import { Sheet } from './Sheet'
import { Locked, Tick } from './SkillTags'

type Step =
  | { kind: 'looking' }
  | { kind: 'failed'; message: string }
  | { kind: 'choosing'; candidates: BringInCandidate[] }
  | { kind: 'done'; outcome: BringInOutcome }
  | { kind: 'undone'; count: number }

/**
 * Bring in skills from your apps. It looks through the skill folders apps on this computer keep,
 * only once the person opens it, and lists what it found by app: the ones that can come in are
 * ticked, the rest say why not. What came in can be taken back with one Undo.
 */
export function BringInSheet({ onClose, onChanged, onBroughtIn }: { onClose: () => void; onChanged: () => void; onBroughtIn?: (names: string[]) => void }) {
  const [step, setStep] = useState<Step>({ kind: 'looking' })
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    previewBringIn()
      .then((candidates) => {
        if (!active) return
        setChosen(new Set(candidates.filter((candidate) => candidate.defaultSelected).map((candidate) => candidate.key)))
        setStep({ kind: 'choosing', candidates })
      })
      .catch((caught: unknown) => { if (active) setStep({ kind: 'failed', message: errorText(caught) }) })
    return () => { active = false }
  }, [attempt])

  async function act(work: () => Promise<void>) {
    setBusy(true); setError('')
    try { await work() } catch (caught) { setError(errorText(caught)) } finally { setBusy(false) }
  }
  const copy = () => act(async () => {
    const outcome = await bringIn([...chosen])
    setStep({ kind: 'done', outcome })
    onChanged()
    onBroughtIn?.(outcome.imported.map((record) => record.name))
  })
  const undo = (batchId: string) => act(async () => {
    const removed = await undoBringIn(batchId)
    setStep({ kind: 'undone', count: removed.length })
    onChanged()
  })

  const title = 'Skills from your apps'
  if (step.kind === 'looking') {
    return (
      <Sheet kicker="On this computer" title={title} onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Cancel</button>}>
        <div className="lw-skills-progress" role="progressbar" aria-label="Looking"><span /></div>
        <p className="lw-skills-quiet">Looking through the skill folders your apps keep. LoomWatch only reads skills there, nothing else.</p>
      </Sheet>
    )
  }
  if (step.kind === 'failed') {
    return (
      <Sheet kicker="On this computer" title={title} onClose={onClose} footer={<>
        <button type="button" className="btn" onClick={onClose}>Close</button>
        <button type="button" className="btn btn-primary" onClick={() => { setStep({ kind: 'looking' }); setAttempt((value) => value + 1) }}>Try again</button>
      </>}>
        <p role="alert" className="inline-error"><span className="detail">{step.message}</span></p>
      </Sheet>
    )
  }
  if (step.kind === 'undone') {
    return (
      <Sheet kicker="On this computer" title={title} onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}>
        <p role="status" className="lw-skills-done-line"><Undo2 size={16} aria-hidden="true" />Took back {skillCount(step.count)}.</p>
      </Sheet>
    )
  }
  if (step.kind === 'done') {
    const { outcome } = step
    return (
      <Sheet kicker="On this computer" title={title} busy={busy} onClose={onClose} footer={<>
        {outcome.imported.length > 0 && <button type="button" className="btn" disabled={busy} onClick={() => void undo(outcome.batchId)}><Undo2 size={14} aria-hidden="true" />{busy ? 'Taking back…' : 'Undo'}</button>}
        <button type="button" className="btn btn-primary" disabled={busy} onClick={onClose}>Done</button>
      </>}>
        <div role="status" className="lw-skills-done">
          <p className="lw-skills-done-line"><Check size={16} aria-hidden="true" />{outcome.imported.length > 0 ? `Brought in ${skillCount(outcome.imported.length)}. Every agent can use ${outcome.imported.length === 1 ? 'it' : 'them'} now.` : 'No skills were brought in.'}</p>
          {outcome.imported.length > 0 && <p className="lw-skills-quiet">{outcome.imported.map((record) => displayName(record.name)).join(', ')}</p>}
          {outcome.skipped.length > 0 && <>
            <h3 className="lw-skills-label">Left out</h3>
            <ul className="lw-skills-skipped">{outcome.skipped.map((skip) => <li key={skip.name}><b>{displayName(skip.name)}</b>: {skip.reason}</li>)}</ul>
          </>}
        </div>
        {error && <p role="alert" className="inline-error"><span className="detail">{error}</span></p>}
      </Sheet>
    )
  }

  const { candidates } = step
  const apps = [...new Set(candidates.map((candidate) => candidate.app))]
  const toggle = (key: string) => {
    const next = new Set(chosen)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setChosen(next)
  }
  return (
    <Sheet kicker="On this computer" title={title} busy={busy} onClose={onClose} footer={candidates.length === 0
      ? <button type="button" className="btn btn-primary" onClick={onClose}>Close</button>
      : <>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy || chosen.size === 0} onClick={() => void copy()}>{busy ? 'Bringing in…' : `Bring in ${skillCount(chosen.size)}`}</button>
      </>}>
      {candidates.length === 0
        ? <p className="lw-skills-quiet">LoomWatch didn’t find skills in your apps’ folders. Search for skills instead.</p>
        : <p className="lw-skills-quiet">Found {skillCount(candidates.length)}. The ticked ones will be copied into LoomWatch; your apps keep their own.</p>}
      {apps.map((app) => {
        const group = candidates.filter((candidate) => candidate.app === app)
        return (
          <section key={app} className="lw-skills-group" aria-label={app}>
            <h3 className="lw-skills-label">{app} <span>{group.length}</span></h3>
            <ul className="lw-skills-picks">
              {group.map((candidate) => <Row key={candidate.key} candidate={candidate} checked={chosen.has(candidate.key)} onToggle={() => toggle(candidate.key)} />)}
            </ul>
          </section>
        )
      })}
      {error && <p role="alert" className="inline-error"><span className="detail">{error}</span></p>}
    </Sheet>
  )
}

function Row({ candidate, checked, onToggle }: { candidate: BringInCandidate; checked: boolean; onToggle: () => void }) {
  const locked = candidate.reason ?? (candidate.alreadyInLoomWatch ? 'You already have it in LoomWatch.' : undefined)
  return (
    <li className={locked ? 'locked' : ''}>
      <Tick checked={checked && !locked} disabled={locked !== undefined} onToggle={onToggle}>
        <b>{displayName(candidate.name)}</b>
        {candidate.description && <span className="lw-skills-pick-desc">{candidate.description}</span>}
      </Tick>
      <span className="lw-skills-pick-facts">
        {candidate.plugin && <span className="lw-skills-tag">{candidate.plugin} plugin</span>}
        <span className={`lw-skills-tag ${candidate.license.restricted ? 'stop' : ''}`}>{licenseLabel(candidate.license)}</span>
        {candidate.runtimes.map((runtime) => <span key={runtime} className="lw-skills-tag needs" title={RUNTIME_LABEL[runtime].hint}>{RUNTIME_LABEL[runtime].label}</span>)}
        <span className="lw-skills-path" title={candidate.path}>{shortPath(candidate.path)}</span>
      </span>
      {locked && <Locked>{locked}</Locked>}
    </li>
  )
}
