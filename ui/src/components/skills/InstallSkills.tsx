import { ExternalLink, ShieldCheck } from 'lucide-react'
import { useState } from 'react'

import {
  errorText, inspectInstall, installSkills, scanLabel, searchSkills, skillCount, sourceName, SkillsApiError,
  type InstallCandidate, type Inspection, type SearchResult, type SearchSource, type SkillSource,
} from '../../lib/library/skillStore'
import { Locked, SkillTags, Tick } from './SkillTags'

type Way = SearchSource | 'github'

const WAYS: { id: Way; label: string }[] = [
  { id: 'skills.sh', label: 'skills.sh' },
  { id: 'clawhub', label: 'ClawHub' },
  { id: 'github', label: 'GitHub link' },
]

/**
 * Install skills: search skills.sh or ClawHub, or paste a GitHub link. Look inside shows every
 * skill the download holds, with its license, files and scripts, before anything is installed;
 * a skill with a name already in LoomWatch is replaced only after asking.
 */
export function InstallSkills({ onChanged }: { onChanged: () => void }) {
  const [way, setWay] = useState<Way>('skills.sh')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [link, setLink] = useState('')
  const [inspection, setInspection] = useState<Inspection | null>(null)
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())
  const [asking, setAsking] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function act(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await work() } catch (caught) { setError(errorText(caught)) } finally { setBusy(false) }
  }
  const search = () => act(async () => {
    if (way === 'github') return
    setResults(await searchSkills(query, way))
  })
  const lookInside = (ref: string, source?: SkillSource) => act(async () => {
    const found = await inspectInstall(ref, source)
    const installable = found.candidates.filter((candidate) => !candidate.reason)
    // One skill is what was asked for; from a repository of many, the person picks.
    setChosen(new Set(found.candidates.length === 1 && installable.length === 1 ? [installable[0].path] : []))
    setInspection(found); setAsking('')
  })
  const install = (replace: boolean) => act(async () => {
    if (!inspection) return
    const picked = inspection.candidates.filter((candidate) => chosen.has(candidate.path))
    const taken = picked.filter((candidate) => candidate.conflict).map((candidate) => `“${candidate.name}”`)
    if (!replace && taken.length > 0) {
      setAsking(`${taken.join(', ')} ${taken.length === 1 ? 'is' : 'are'} already in LoomWatch. Replace ${taken.length === 1 ? 'it' : 'them'}?`)
      return
    }
    try {
      const installed = await installSkills(inspection.token, picked.map((candidate) => candidate.path), replace)
      setNotice(`Installed ${installed.length === 1 ? installed[0].name : skillCount(installed.length)}.`)
      setInspection(null); setAsking('')
      onChanged()
    } catch (caught) {
      // Someone added one with that name since this look: ask, as for any other.
      if (caught instanceof SkillsApiError && caught.status === 409) { setAsking(caught.message); return }
      throw caught
    }
  })
  const toggle = (path: string) => setChosen((current) => {
    const next = new Set(current)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })
  const choose = (next: Way) => { setWay(next); setResults(null); setError('') }

  return (
    <section className="e1 lw-settings-section" aria-labelledby="skills-install-heading" aria-busy={busy}>
      <h2 id="skills-install-heading" className="t-title">Install skills</h2>
      <p className="t-body lw-settings-quiet">Find skills other people have shared on skills.sh and ClawHub, or paste a link to one on GitHub. LoomWatch downloads it and shows you what’s inside before anything is installed. Nothing in a skill runs while it installs.</p>
      {error && <p role="alert" className="inline-error t-body"><span className="detail">{error}</span></p>}
      {notice && <p role="status" className="lw-notice t-meta">{notice}</p>}

      {inspection ? <Inside inspection={inspection} chosen={chosen} onToggle={toggle} busy={busy} asking={asking}
        onInstall={() => void install(false)} onReplace={() => void install(true)} onCancelReplace={() => setAsking('')}
        onBack={() => { setInspection(null); setAsking('') }} /> : <>
        <div className="lw-skills-switch" role="radiogroup" aria-label="Where to find skills">
          {WAYS.map((option) => <button key={option.id} type="button" role="radio" aria-checked={way === option.id} onClick={() => choose(option.id)}>{option.label}</button>)}
        </div>
        {way === 'github' ? <>
          <form className="lw-settings-search" onSubmit={(event) => { event.preventDefault(); void lookInside(link.trim()) }}>
            <label className="field"><span className="t-meta">Paste a GitHub link</span>
              <input className="input" value={link} maxLength={500} spellCheck={false} onChange={(event) => setLink(event.target.value)} placeholder="github.com/owner/repo, or owner/repo" />
            </label>
            <button className="btn btn-primary" disabled={busy || !link.trim()}>{busy ? 'Looking…' : 'Look inside'}</button>
          </form>
          <p className="t-meta lw-settings-quiet">A skill on GitHub is a folder with a SKILL.md file in it. LoomWatch lists every one it finds, and you choose which to install. Links from skills.sh and ClawHub work here too.</p>
        </> : <>
          <form className="lw-settings-search" onSubmit={(event) => { event.preventDefault(); void search() }}>
            <label className="field"><span className="t-meta">Search {sourceName(way)}</span>
              <input className="input" value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} placeholder="What should the skill help with?" />
            </label>
            <button className="btn btn-primary" disabled={busy || !query.trim()}>{busy ? 'Searching…' : 'Search'}</button>
          </form>
          {results && results.length === 0 && <p className="t-meta lw-settings-quiet">No skills found. Try other words.</p>}
          {results && results.length > 0 && <ul className="lw-skills-list" aria-label="Search results">
            {results.map((result) => <li key={`${result.source}:${result.id}`} className="e2 lw-skills-item">
              <div className="lw-skills-item-head">
                <span className="t-body-m lw-skills-name">{result.name}</span>
                <button type="button" className="btn" disabled={busy} aria-label={`Look inside ${result.name}`} onClick={() => void lookInside(result.ref, result.source)}>Look inside</button>
              </div>
              {result.description && <p className="t-meta lw-skills-desc">{result.description}</p>}
              <p className="t-meta lw-settings-quiet">
                {result.source !== way && `On ${sourceName(result.source)} · `}
                {result.installs !== undefined && `${result.installs.toLocaleString()} installs · `}
                <a className="link lw-skills-out" href={result.url} target="_blank" rel="noreferrer">Open its page<ExternalLink size={11} aria-hidden="true" /></a>
              </p>
            </li>)}
          </ul>}
        </>}
      </>}
    </section>
  )
}

function Inside({ inspection, chosen, onToggle, busy, asking, onInstall, onReplace, onCancelReplace, onBack }: {
  inspection: Inspection
  chosen: ReadonlySet<string>
  onToggle: (path: string) => void
  busy: boolean
  asking: string
  onInstall: () => void
  onReplace: () => void
  onCancelReplace: () => void
  onBack: () => void
}) {
  const count = inspection.candidates.filter((candidate) => chosen.has(candidate.path)).length
  return (
    <div className="lw-skills-inside" aria-label={`Inside ${inspection.title}`} role="group">
      <div className="lw-skills-item-head">
        <span className="t-body-m">{inspection.title}</span>
        <span className="t-meta lw-settings-quiet">
          From {sourceName(inspection.source)}
          {inspection.url && <>{' · '}<a className="link lw-skills-out" href={inspection.url} target="_blank" rel="noreferrer">Open its page<ExternalLink size={11} aria-hidden="true" /></a></>}
        </span>
      </div>
      {inspection.scan && <p className={`t-meta lw-skills-scan ${inspection.scan.status === 'clean' && !inspection.scan.hasWarnings ? 'ok' : ''}`}><ShieldCheck size={13} aria-hidden="true" />{scanLabel(inspection.scan)}</p>}
      {inspection.notes.map((note) => <p key={note} className="t-meta lw-settings-quiet">{note}</p>)}
      <p className="t-meta lw-settings-quiet">{inspection.candidates.length === 1 ? 'It holds 1 skill.' : `It holds ${inspection.candidates.length} skills. Tick the ones to install.`}</p>
      <ul className="lw-skills-list" aria-label="Skills inside">
        {inspection.candidates.map((candidate) => <Found key={candidate.path} candidate={candidate} checked={chosen.has(candidate.path)} onToggle={() => onToggle(candidate.path)} />)}
      </ul>
      {asking ? <div className="lw-skills-confirm" role="group" aria-label="Replace skills?">
        <span className="t-body">{asking}</span>
        <span className="t-meta lw-settings-quiet">The copy LoomWatch has now moves to a removed folder.</span>
        <span className="lw-skills-actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onReplace}>{busy ? 'Replacing…' : 'Replace'}</button>
          <button type="button" className="btn" disabled={busy} onClick={onCancelReplace}>Cancel</button>
        </span>
      </div> : <span className="lw-skills-actions">
        <button type="button" className="btn btn-primary" disabled={busy || count === 0} onClick={onInstall}>{busy ? 'Installing…' : `Install ${skillCount(count)}`}</button>
        <button type="button" className="btn" disabled={busy} onClick={onBack}>Back</button>
      </span>}
    </div>
  )
}

function Found({ candidate, checked, onToggle }: { candidate: InstallCandidate; checked: boolean; onToggle: () => void }) {
  return (
    <li className={`lw-skills-row ${candidate.reason ? 'locked' : ''}`}>
      <Tick checked={checked && !candidate.reason} disabled={candidate.reason !== undefined} onToggle={onToggle}>
        <b className="t-body">{candidate.name}</b>
        {candidate.path !== '.' && <span className="t-meta">{candidate.path}</span>}
      </Tick>
      <div className="lw-skills-row-body">
        {candidate.description && <p className="t-meta lw-skills-desc">{candidate.description}</p>}
        <SkillTags license={candidate.license} runtimes={candidate.runtimes} needs={candidate.needs} hasScripts={candidate.hasScripts} sizeBytes={candidate.sizeBytes} />
        {candidate.hasScripts && !candidate.reason && <p className="t-meta lw-settings-quiet">It comes with scripts. Nothing runs while it installs; your agents run them only when a task needs them.</p>}
        {candidate.conflict && !candidate.reason && <p className="t-meta lw-skills-conflict">A skill named “{candidate.name}” is already in LoomWatch. Installing this one replaces it, after asking.</p>}
        {candidate.files.length > 0 && <details className="lw-skills-files">
          <summary className="t-meta">{candidate.files.length === 1 ? '1 file' : `${candidate.files.length} files`}</summary>
          <ul className="t-meta">{candidate.files.map((file) => <li key={file}>{file}</li>)}</ul>
        </details>}
        {candidate.reason && <Locked>{candidate.reason}</Locked>}
      </div>
    </li>
  )
}
