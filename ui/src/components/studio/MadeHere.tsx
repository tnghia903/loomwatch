import { useState } from 'react'

import type { MadeFile } from '../../lib/projects/glance'
import { FileCard } from '../ui/FileCard'

/** How many files show before "Show all". */
const SHOWN = 8

/**
 * What the agents here made, newest work first (ADR 0097): each file one press from being read. With
 * more than one team, a row of teams narrows it to one team's.
 */
export function MadeHere({ files, teams }: { files: readonly MadeFile[]; teams: readonly { path: string; name: string }[] }) {
  const [only, setOnly] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  if (files.length === 0) return null
  const makers = teams.filter((team) => files.some((file) => file.team === team.path))
  const shown = only ? files.filter((file) => file.team === only) : files
  const listed = all ? shown : shown.slice(0, SHOWN)
  return (
    <section className="made-here" aria-labelledby="made-here-title">
      <div className="made-here-head">
        <h2 id="made-here-title" className="studio-head">Made here</h2>
        {makers.length > 1 && (
          <span className="made-here-teams" role="group" aria-label="Show what a team made">
            <button type="button" aria-pressed={only === null} onClick={() => setOnly(null)}>All</button>
            {makers.map((team) => <button key={team.path} type="button" aria-pressed={only === team.path} onClick={() => setOnly(team.path)}>{team.name}</button>)}
          </span>
        )}
      </div>
      <ul className="made-here-files">
        {listed.map((file) => <li key={file.path}><FileCard path={file.path} compact /></li>)}
      </ul>
      {shown.length > SHOWN && !all && <button type="button" className="link" onClick={() => setAll(true)}>Show all {shown.length}</button>}
    </section>
  )
}
