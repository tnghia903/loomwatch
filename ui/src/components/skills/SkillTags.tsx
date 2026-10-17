import { Lock } from 'lucide-react'
import type { ReactNode } from 'react'

import { formatSize, licenseLabel, needLabel, RUNTIME_LABEL, type Runtime, type SkillLicense } from '../../lib/library/skillStore'

/**
 * What a skill is and needs, as small labels: its license, Needs Node or Needs Python, whether it
 * has scripts, what its instructions assume, and its size. Spans, so a row can hold it anywhere.
 */
export function SkillTags({ license, runtimes, needs, hasScripts, sizeBytes }: {
  license: SkillLicense
  runtimes: Runtime[]
  needs: string[]
  hasScripts: boolean
  sizeBytes: number
}) {
  // "Needs Node" already says it runs scripts; the need of the same name would say it twice.
  const shownNeeds = needs.filter((need) => need !== 'scripts' || !hasScripts)
  return (
    <span className="lw-skills-tags">
      <span className={`lw-skills-tag ${license.restricted ? 'alert' : ''}`}>
        {license.restricted && <Lock size={11} aria-hidden="true" />}{licenseLabel(license)}
      </span>
      {runtimes.map((runtime) => <span key={runtime} className="lw-skills-tag needs" title={RUNTIME_LABEL[runtime].hint}>{RUNTIME_LABEL[runtime].label}</span>)}
      {hasScripts && runtimes.length === 0 && <span className="lw-skills-tag needs" title="It comes with scripts your agents can run when a task needs them.">Has scripts</span>}
      {shownNeeds.map((need) => <span key={need} className="lw-skills-tag">{needLabel(need)}</span>)}
      {sizeBytes > 0 && <span className="lw-skills-tag quiet">{formatSize(sizeBytes)}</span>}
    </span>
  )
}

/** One row's tick box, in the house `.check` style; its text is the box's name. */
export function Tick({ checked, disabled = false, onToggle, children }: { checked: boolean; disabled?: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} disabled={disabled} className={`check ${checked ? 'on' : ''}`} onClick={onToggle}>
      <span className="box">{checked && <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>}</span>
      <span className="txt">{children}</span>
    </button>
  )
}

/** Why a row can't be ticked, beside its lock. */
export function Locked({ children }: { children: ReactNode }) {
  return <p className="t-meta lw-skills-locked"><Lock size={12} aria-hidden="true" />{children}</p>
}
