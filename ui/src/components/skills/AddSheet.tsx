import { ExternalLink, Search } from 'lucide-react'
import { useMemo, useState } from 'react'

import {
  displayName, errorText, installSkills, licenseLabel, noticesFor, RUNTIME_LABEL, scanNotice, skillCount, SkillsApiError, sourceName,
  type InstallCandidate, type Inspection, type Publisher, type SkillRecord,
} from '../../lib/library/skillStore'
import { Sheet } from './Sheet'
import { By, Glyph, Locked, NeedTags, Notices, Tick } from './SkillTags'
import { InlineMarkdown } from '../ui/Markdown'

/** One add, from the moment Add is pressed: downloading, ready to review, or failed. */
export type Adding =
  | { kind: 'loading'; label: string }
  | { kind: 'ready'; inspection: Inspection }
  | { kind: 'failed'; label: string; message: string; retry: () => void }

/**
 * The skills a look inside offers. One whose license keeps it out isn't shown beside ones that
 * can come in; only when nothing else is there does the sheet show it, to say why.
 */
const offeredOf = (candidates: InstallCandidate[]): InstallCandidate[] => {
  const open = candidates.filter((candidate) => !candidate.license.restricted)
  return open.length > 0 ? open : candidates
}

const firstChoice = (adding: Adding): ReadonlySet<string> => {
  if (adding.kind !== 'ready') return new Set()
  const offered = offeredOf(adding.inspection.candidates)
  if (offered.length !== 1) return new Set()
  const [only] = offered
  return new Set(only.reason ? [] : [only.path])
}

/**
 * The review before an add. It opens at once, while LoomWatch downloads the skill, then says what
 * to know in plain words: license, scripts, ClawHub's safety check, and whether it replaces a
 * skill you have. One skill is ready to add with one click; from a collection, you tick the ones
 * you want. It is one sheet from first moment to last, so focus and place hold while it loads.
 */
export function AddSheet({ adding, publisher, onClose, onAdded, returnFocus }: {
  adding: Adding
  publisher?: Publisher
  onClose: () => void
  onAdded: (records: SkillRecord[], replaced: boolean) => void
  returnFocus?: string
}) {
  const token = adding.kind === 'ready' ? adding.inspection.token : null
  const [shown, setShown] = useState(token)
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => firstChoice(adding))
  const [filter, setFilter] = useState('')
  const [asking, setAsking] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // A new look starts its choices afresh.
  if (token !== shown) {
    setShown(token)
    setChosen(firstChoice(adding))
    setFilter(''); setAsking(''); setBusy(false); setError('')
  }

  if (adding.kind !== 'ready') {
    const loading = adding.kind === 'loading'
    return (
      <Sheet kicker={loading ? 'Looking inside' : 'Couldn’t look inside'} title={adding.label} onClose={onClose} returnFocus={returnFocus} footer={loading
        ? <button type="button" className="btn" onClick={onClose}>Cancel</button>
        : <>
          <button type="button" className="btn" onClick={onClose}>Close</button>
          <button type="button" className="btn btn-primary" onClick={adding.retry}>Try again</button>
        </>}>
        {loading
          ? <>
            <div className="lw-skills-progress" role="progressbar" aria-label="Downloading"><span /></div>
            <p className="lw-skills-quiet">Downloading it so you can see what’s inside. Nothing runs, and nothing is added until you say so.</p>
          </>
          : <p role="alert" className="inline-error"><span className="detail">{adding.message}</span></p>}
      </Sheet>
    )
  }

  const { inspection } = adding
  const candidates = offeredOf(inspection.candidates)
  const single = candidates.length === 1 ? candidates[0] : null
  const picked = candidates.filter((candidate) => chosen.has(candidate.path))
  const replacing = picked.filter((candidate) => candidate.conflict)

  async function add(replace: boolean) {
    setBusy(true); setError('')
    try {
      const records = await installSkills(inspection.token, picked.map((candidate) => candidate.path), replace)
      onAdded(records, replace)
    } catch (caught) {
      // Someone added one with that name since this look: ask, as for any other.
      if (caught instanceof SkillsApiError && caught.status === 409) setAsking(caught.message)
      else setError(errorText(caught))
      setBusy(false)
    }
  }
  const page = inspection.url && <a className="link lw-skills-out" href={inspection.url} target="_blank" rel="noreferrer">Open its page<ExternalLink size={11} aria-hidden="true" /></a>
  const footer = asking
    ? <>
      <span className="lw-skills-foot-note">{asking}</span>
      <button type="button" className="btn" disabled={busy} onClick={() => setAsking('')}>Cancel</button>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void add(true)}>{busy ? 'Replacing…' : 'Replace'}</button>
    </>
    : single?.reason
      ? <button type="button" className="btn btn-primary" onClick={onClose}>Close</button>
      : <>
        {!single && replacing.length > 0 && <span className="lw-skills-foot-note">Replaces your {replacing.map((candidate) => `“${candidate.name}”`).join(', ')}.</span>}
        <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy || picked.length === 0} onClick={() => void add(replacing.length > 0)}>
          {busy ? 'Adding…' : single ? (replacing.length > 0 ? 'Replace and add' : 'Add skill') : `Add ${skillCount(picked.length)}`}
        </button>
      </>

  return (
    <Sheet kicker={`From ${sourceName(inspection.source)}`} title={single ? displayName(single.name) : inspection.title} busy={busy} onClose={onClose} footer={footer} returnFocus={returnFocus}>
      {single ? <>
        <div className="lw-skills-intro">
          <Glyph name={single.name} description={single.description} size="lg" />
          <div>
            {single.description && <p className="lw-skills-intro-desc"><InlineMarkdown>{single.description}</InlineMarkdown></p>}
            <p className="lw-skills-quiet lw-skills-byline">
              {publisher ? <By publisher={publisher} /> : inspection.title}
              {page && <>{' · '}{page}</>}
            </p>
          </div>
        </div>
        {!single.reason && <NeedTags runtimes={single.runtimes} needs={single.needs} hasScripts={single.hasScripts} />}
        <Notices notices={noticesFor(single, inspection.scan)} />
        {inspection.notes.map((note) => <p key={note} className="lw-skills-quiet">{note}</p>)}
        {single.files.length > 0 && <Files files={single.files} />}
        {single.reason && <p className="lw-skills-quiet">Close this and try another skill from your search.</p>}
      </> : <>
        <p className="lw-skills-quiet">It holds {skillCount(candidates.length)}. Tick the ones you want.{page && <>{' '}{page}</>}</p>
        {inspection.scan && <Notices notices={[scanNotice(inspection.scan)]} />}
        {inspection.notes.map((note) => <p key={note} className="lw-skills-quiet">{note}</p>)}
        <Picker candidates={candidates} chosen={chosen} filter={filter} onFilter={setFilter} onChange={setChosen} />
      </>}
      {error && <p role="alert" className="inline-error"><span className="detail">{error}</span></p>}
    </Sheet>
  )
}

function Files({ files }: { files: string[] }) {
  return (
    <details className="lw-skills-files">
      <summary>What’s inside: {files.length === 1 ? '1 file' : `${files.length} files`}</summary>
      <ul>{files.map((file) => <li key={file}>{file}</li>)}</ul>
    </details>
  )
}

/** Many skills from one download: tick the ones to add, with a filter once the list is long. */
function Picker({ candidates, chosen, filter, onFilter, onChange }: {
  candidates: InstallCandidate[]
  chosen: ReadonlySet<string>
  filter: string
  onFilter: (value: string) => void
  onChange: (next: ReadonlySet<string>) => void
}) {
  const needle = filter.trim().toLowerCase()
  const shown = useMemo(() => candidates.filter((candidate) => !needle || `${candidate.name} ${candidate.description}`.toLowerCase().includes(needle)), [candidates, needle])
  const addable = shown.filter((candidate) => !candidate.reason)
  const allOn = addable.length > 0 && addable.every((candidate) => chosen.has(candidate.path))
  const toggle = (path: string) => {
    const next = new Set(chosen)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    onChange(next)
  }
  const toggleAll = () => {
    const next = new Set(chosen)
    for (const candidate of addable) {
      if (allOn) next.delete(candidate.path)
      else next.add(candidate.path)
    }
    onChange(next)
  }
  return (
    <div className="lw-skills-picker">
      <div className="lw-skills-picker-head">
        {candidates.length > 8 && <label className="lw-skills-filter"><Search size={14} aria-hidden="true" /><input value={filter} placeholder="Filter" aria-label="Filter skills" onChange={(event) => onFilter(event.target.value)} /></label>}
        {addable.length > 1 && <button type="button" className="link" onClick={toggleAll}>{allOn ? 'Clear all' : `Select all ${addable.length}`}</button>}
      </div>
      <ul className="lw-skills-picks" aria-label="Skills inside">
        {shown.map((candidate) => (
          <li key={candidate.path} className={candidate.reason ? 'locked' : ''}>
            <Tick checked={chosen.has(candidate.path) && !candidate.reason} disabled={candidate.reason !== undefined} onToggle={() => toggle(candidate.path)}>
              <b>{displayName(candidate.name)}</b>
              {candidate.description && <span className="lw-skills-pick-desc"><InlineMarkdown clickable={false}>{candidate.description}</InlineMarkdown></span>}
            </Tick>
            <span className="lw-skills-pick-facts">
              <span className={`lw-skills-tag ${candidate.license.restricted ? 'stop' : ''}`}>{licenseLabel(candidate.license)}</span>
              {candidate.runtimes.map((runtime) => <span key={runtime} className="lw-skills-tag needs" title={RUNTIME_LABEL[runtime].hint}>{RUNTIME_LABEL[runtime].label}</span>)}
              {candidate.hasScripts && candidate.runtimes.length === 0 && <span className="lw-skills-tag needs">Has scripts</span>}
              {candidate.conflict && !candidate.reason && <span className="lw-skills-tag note">Replaces yours</span>}
            </span>
            {candidate.reason && <Locked>{candidate.reason}</Locked>}
          </li>
        ))}
      </ul>
      {shown.length === 0 && <p className="lw-skills-quiet">Nothing matches “{filter}”.</p>}
    </div>
  )
}
