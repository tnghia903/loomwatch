import { ArrowLeft, Check, ExternalLink, Lock, Plus } from 'lucide-react'
import { useState } from 'react'

import { compactCount, displayName, ownerOf, publisherOf, resultKey, skillNameOf, sourceName, type SearchResult, type SearchSource } from '../../lib/library/skillStore'
import { By, Glyph } from './SkillTags'

/** Where one result stands: already yours, just added, being checked, or not addable. */
export type ResultState = { kind: 'have' | 'added' | 'checking' } | { kind: 'blocked'; reason: string }

const FIRST = 12

/**
 * What a search found, as cards with one button each. Add opens the review sheet; nothing is
 * added from here directly.
 */
export function Results({ query, results, missed, loading, error, stateOf, onAdd, onClear }: {
  query: string
  results: SearchResult[]
  missed: SearchSource[]
  loading: boolean
  error: string
  stateOf: (result: SearchResult) => ResultState | null
  onAdd: (result: SearchResult) => void
  onClear: () => void
}) {
  const [all, setAll] = useState(false)
  const shown = all ? results : results.slice(0, FIRST)
  return (
    <section className="lw-skills-results" aria-labelledby="skills-results-heading" aria-busy={loading}>
      <div className="lw-skills-results-head">
        <h2 id="skills-results-heading" className="lw-skills-label">{loading ? `Looking for “${query}”…` : `Skills for “${query}”`}</h2>
        <button type="button" className="link lw-skills-back" onClick={onClear}><ArrowLeft size={13} aria-hidden="true" />All topics</button>
      </div>
      {error && <p role="alert" className="home-empty alert">{error}</p>}
      {!loading && missed.length > 0 && results.length > 0 && <p className="lw-skills-quiet">{missed.map(sourceName).join(' and ')} didn’t answer, so these are from {missed.includes('clawhub') ? 'skills.sh' : 'ClawHub'} only.</p>}
      {loading && <ul className="lw-skills-cards" aria-hidden="true">{Array.from({ length: 4 }, (_, index) => <li key={index} className="lw-skills-card ghost"><span /><span /><span /></li>)}</ul>}
      {!loading && !error && results.length === 0 && <p className="home-empty">No skills found for “{query}”. Try fewer or other words, or start from a topic.</p>}
      {!loading && results.length > 0 && <>
        <ul className="lw-skills-cards" aria-label="Search results">
          {shown.map((result) => <Card key={resultKey(result)} result={result} state={stateOf(result)} onAdd={() => onAdd(result)} />)}
        </ul>
        {!all && results.length > FIRST && <button type="button" className="btn lw-skills-more" onClick={() => setAll(true)}>Show {results.length - FIRST} more</button>}
      </>}
    </section>
  )
}

function Card({ result, state, onAdd }: { result: SearchResult; state: ResultState | null; onAdd: () => void }) {
  const name = displayName(result.name)
  const owner = ownerOf(result.ref)
  const collection = result.source === 'skills.sh' ? result.ref.split('/').slice(0, 2).join('/') : null
  return (
    <li className={`lw-skills-card ${state?.kind ?? ''}`} data-result={resultKey(result)} tabIndex={-1}>
      <div className="lw-skills-card-top">
        <Glyph name={skillNameOf(result.ref)} description={result.description} />
        <div className="lw-skills-card-who">
          <h3>{name}</h3>
          <By publisher={publisherOf(result)} />
        </div>
      </div>
      <p className="lw-skills-card-desc">{result.description ?? (collection ? `Part of the ${collection} collection on GitHub.` : 'No description given.')}</p>
      <div className="lw-skills-card-foot">
        <span className="lw-skills-card-meta">
          {result.installs !== undefined && <>{compactCount(result.installs)} installs · </>}
          <a href={result.url} target="_blank" rel="noreferrer" aria-label={`${name} on ${sourceName(result.source)}`}>{sourceName(result.source)}<ExternalLink size={10} aria-hidden="true" /></a>
        </span>
        <AddButton label={`${name} by ${owner}`} state={state} onAdd={onAdd} />
      </div>
    </li>
  )
}

function AddButton({ label, state, onAdd }: { label: string; state: ResultState | null; onAdd: () => void }) {
  switch (state?.kind) {
    case 'have': return <span className="lw-skills-pill ok"><Check size={13} aria-hidden="true" />You have this</span>
    case 'added': return <span className="lw-skills-pill ok"><Check size={13} aria-hidden="true" />Added</span>
    case 'blocked': return <span className="lw-skills-pill stop" title={state.reason}><Lock size={12} aria-hidden="true" />Can’t add</span>
    case 'checking': return <button type="button" className="btn lw-skills-add" disabled>Checking…</button>
    default: return <button type="button" className="btn lw-skills-add" aria-label={`Add ${label}`} onClick={onAdd}><Plus size={14} aria-hidden="true" />Add</button>
  }
}
