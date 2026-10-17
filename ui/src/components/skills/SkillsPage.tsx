import { ArrowLeft } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { errorText, fetchSkills, type SkillsFolder } from '../../lib/library/skillStore'
import { BringIn } from './BringIn'
import { InstallSkills } from './InstallSkills'
import { YourSkills } from './YourSkills'

/**
 * Skills (`/skills`): LoomWatch's own skills folder. Your skills lists what is in it; Bring in
 * copies skills from apps on this computer; Install fetches them from skills.sh, ClawHub or
 * GitHub. Nothing is looked for or downloaded until the person asks.
 *
 * A settings surface: the `lw-settings-*` reading column Connections set, with this page's own
 * parts in styles/skills.css.
 */
export function SkillsPage() {
  const [folder, setFolder] = useState<SkillsFolder | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try { setFolder(await fetchSkills()); setError('') } catch (caught) { setError(errorText(caught)) }
  }, [])
  useEffect(() => {
    let active = true
    fetchSkills()
      .then((value) => { if (active) setFolder(value) })
      .catch((caught: unknown) => { if (active) setError(errorText(caught)) })
    return () => { active = false }
  }, [])

  return (
    <main className="lw-settings lw-skills">
      <div className="lw-settings-column">
        <a href="/" className="link lw-settings-back"><ArrowLeft size={14} aria-hidden="true" /> Back to the canvas</a>
        <div className="lw-settings-head">
          <h1 className="t-display">Skills</h1>
          <p className="t-body">Skills are instructions your agents can follow for a kind of work, like writing a report or filling in a form. Give a skill to an agent from the Library when you build a team.</p>
        </div>
        <YourSkills folder={folder} error={error} onRetry={() => void load()} onChanged={() => void load()} />
        <BringIn onChanged={() => void load()} />
        <InstallSkills onChanged={() => void load()} />
      </div>
    </main>
  )
}
