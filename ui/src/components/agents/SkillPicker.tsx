import { useMemo, useState } from 'react'
import { Plus, Puzzle, Search, X } from 'lucide-react'

import type { DetectedCapability } from '../../lib/library/client'

export interface SkillPickerProps {
  chosen: readonly string[]
  available: readonly DetectedCapability[]
  loading?: boolean
  onChange: (skills: string[]) => void
}

const SHOWN = 8

/**
 * The skills an agent is given. Skills found on this computer, from any app, work with whichever
 * app the agent runs on (ADR 0031), so the list is the same whatever app is chosen.
 */
export function SkillPicker({ chosen, available, loading = false, onChange }: SkillPickerProps) {
  const [query, setQuery] = useState('')
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const seen = new Set<string>()
    return available
      .filter((skill) => !chosen.includes(skill.name) && (!needle || `${skill.name} ${skill.detail}`.toLowerCase().includes(needle)))
      .filter((skill) => (seen.has(skill.name) ? false : (seen.add(skill.name), true)))
      .slice(0, SHOWN)
  }, [available, chosen, query])
  return (
    <div className="skill-picker">
      {chosen.length > 0
        ? <ul className="skill-picker-chosen" aria-label="Skills it is given">
          {chosen.map((name) => <li key={name}><Puzzle size={12} aria-hidden="true" />{name}<button type="button" className="iconbtn" aria-label={`Take ${name} away`} onClick={() => onChange(chosen.filter((skill) => skill !== name))}><X size={12} aria-hidden="true" /></button></li>)}
        </ul>
        : <p className="t-meta">No skills yet. A skill is a set of instructions it opens when the work calls for it.</p>}
      <label className="skill-picker-find"><Search size={13} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={loading ? 'Looking for skills on this computer…' : `Find a skill (${available.length} on this computer)`} aria-label="Find a skill" /></label>
      {(query || chosen.length === 0) && matches.length > 0 && (
        <ul className="skill-picker-found" aria-label="Skills you can add">
          {matches.map((skill) => <li key={skill.id}><button type="button" onClick={() => { onChange([...chosen, skill.name]); setQuery('') }}><Plus size={12} aria-hidden="true" /><b>{skill.name}</b><span>{skill.detail || skill.source}</span></button></li>)}
        </ul>
      )}
      {query && matches.length === 0 && !loading && <p className="t-meta">No skill matches “{query}”.</p>}
    </div>
  )
}
