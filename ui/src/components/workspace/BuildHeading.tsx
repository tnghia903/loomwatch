import { Check, Clock3, Lightbulb, Play, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { CheckupFinding } from '../../lib/team-file/checkup'
import type { TeamUsage } from '../../lib/team-file/runLessons'
import { formatTokens } from '../../lib/format'
import type { SaveState } from '../../lib/team-file/useTeamDocument'
import { CheckupItem } from '../canvas/AgentCheckup'

interface BuildHeadingProps {
  agentCount: number
  isValid: boolean
  /** The schema is still loading, so validity is not known yet. */
  checking: boolean
  saveState: SaveState
  /** What stops an agent's app from starting on this computer, when something does. */
  appProblem?: string | null
  /**
   * Connections drawn on the canvas before their kind was delivered, which no run receives yet
   * (ADR 0029). Said here rather than over the canvas, where it would hide the cards it is about.
   */
  undelivered?: number
  onDeliver?: () => void
  onRun: () => void
  /** Start a schedule for a team that has none. Once it has one, its card on the canvas opens it. */
  onSchedule?: () => void
  /** An Ask LoomWatch proposal is on the canvas: the heading becomes its Apply or Discard. */
  proposal?: BuildProposal | null
  /** The team checkup (lib/team-file/checkup.ts), once the team is otherwise ready to run. */
  checkup?: HeadingCheckup | null
  /** What the team's recent runs used, as their model calls counted it; null before any did. */
  usage?: TeamUsage | null
}

/**
 * The heading lists the suggestions and opens the agent each is about; the fixes themselves are in
 * that agent's panel and nowhere else, so no fix has two buttons on one screen (ADR 0043).
 */
export interface HeadingCheckup {
  findings: readonly CheckupFinding[]
  /** Suggestions the operator hid for this team, which "Show hidden" brings back. */
  hiddenCount: number
  onRestore: () => void
  onOpenAgent: (agentId: string) => void
  names: ReadonlyMap<string, string>
}

export interface BuildProposal {
  isNew: boolean
  /** Who proposed it: Ask LoomWatch, or the connected app that called LoomWatch's tools. */
  from: string
  /** What the proposal changes, in plain words. */
  lines: string[]
  applying: boolean
  error: string | null
  onApply: () => void
  onDiscard: () => void
}

/** Build's heading. It says what to do next, not what the screen is called. */
export function BuildHeading({ agentCount, isValid, checking, saveState, appProblem = null, undelivered = 0, onDeliver, onRun, onSchedule, proposal = null, checkup = null, usage = null }: BuildHeadingProps) {
  const [checkupOpen, setCheckupOpen] = useState(false)
  if (proposal) {
    return (
      <header className="build-workspace-heading proposal" aria-label="Proposal from Ask LoomWatch">
        <div>
          <h1>{proposal.isNew ? 'Check your new team' : 'Check the proposed changes'}</h1>
          <span>From {proposal.from} · not saved yet</span>
          {proposal.lines.length > 0 && <ul className="build-proposal-lines">{proposal.lines.map((line) => <li key={line}>{line}</li>)}</ul>}
          {proposal.error && <p role="alert" className="build-proposal-error">{proposal.error}</p>}
        </div>
        <div className="build-workspace-actions">
          <button className="btn" disabled={proposal.applying} onClick={proposal.onDiscard}>Discard</button>
          <button className="btn btn-primary" disabled={proposal.applying} onClick={proposal.onApply}><Check size={15} />{proposal.applying ? 'Applying…' : 'Apply'}</button>
        </div>
      </header>
    )
  }
  const base = agentCount === 0
    ? { title: 'Add your first agent', detail: 'Pick a job on the left, like Researcher or Writer. You can add more helpers and connect them later.' }
    : !isValid && !checking
      ? { title: 'Finish setting up', detail: 'Open the list at the top to see what still needs your attention.' }
      : appProblem
        ? { title: 'Finish setting up', detail: appProblem }
        : { title: 'Your team is ready', detail: 'Press Run team and describe what you want done. Add agents and connect them to hand work along.' }
  // A suggestion only speaks once the team is otherwise ready: a missing app or an invalid file
  // comes first. One that would leave work undone changes the heading; the rest wait behind a chip.
  const findings = base.title === 'Your team is ready' ? checkup?.findings ?? [] : []
  const firstFix = findings.find((finding) => finding.severity === 'fix')
  const heading = firstFix ? { title: 'Almost ready', detail: `${firstFix.title}. ${firstFix.why}` } : base
  const chip = findings.length === 0 ? null : firstFix
    ? `${findings.length === 1 ? 'Fix it' : `See all ${findings.length}`}`
    : `${findings.length === 1 ? 'One way' : `${findings.length} ways`} to make it work better`
  return (
    <header className="build-workspace-heading">
      <div>
        <h1>{heading.title}</h1>
        <span>{saveState === 'new' ? 'Not saved yet' : ['dirty', 'conflict', 'error'].includes(saveState) ? 'Unsaved changes' : 'Saved'}</span>
        {/* What a run of this team costs, beside the choices that set it: how many agents, which
            apps and models. A fact, from its own runs, never an estimate. */}
        {usage && <span className="build-usage" title={`Average over the last ${usage.runs === 1 ? 'run' : `${usage.runs} runs`}, as the model calls counted it, cached tokens included.`}>About {formatTokens(usage.perRun)} tokens a run</span>}
        {/* Only once the team is otherwise ready: a missing app or an invalid file comes first. */}
        {heading.title === 'Your team is ready' && undelivered > 0 && onDeliver ? (
          <p className="build-undelivered" role="status">
            {undelivered === 1 ? 'One connection on the canvas is' : `${undelivered} connections on the canvas are`} drawn but not delivered to agents yet.{' '}
            <button type="button" className="btn" onClick={onDeliver}>Deliver on the next run</button>
          </p>
        ) : <p>{heading.detail}{chip && checkup && <>{' '}<button type="button" className={`checkup-chip ${firstFix ? 'fix' : ''}`} aria-expanded={checkupOpen} onClick={() => setCheckupOpen((open) => !open)}><Lightbulb size={13} aria-hidden="true" />{chip}</button></>}</p>}
        {checkupOpen && checkup && findings.length > 0 && <TeamCheckupList checkup={checkup} findings={findings} onClose={() => setCheckupOpen(false)} />}
      </div>
      {/* Saving is the team chip's at the top, on every screen (ADR 0043). */}
      <div className="build-workspace-actions">
        {onSchedule && agentCount > 0 && <button className="btn" title="Run this team on its own, at a time you choose" onClick={onSchedule}><Clock3 size={15} aria-hidden="true" />Schedule</button>}
        <button className="btn btn-primary" data-tour="run-team" onClick={onRun}><Play size={15} />Run team</button>
      </div>
    </header>
  )
}

/**
 * The team checkup's whole list, under the heading that counts it. Each row says what and why, and
 * opens the agent it is about: its panel holds the fix (ADR 0043, one control per action).
 */
function TeamCheckupList({ checkup, findings, onClose }: { checkup: HeadingCheckup; findings: readonly CheckupFinding[]; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    ref.current?.focus()
    const outside = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (ref.current && target && !ref.current.contains(target) && !target.closest('.checkup-chip')) onClose()
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [onClose])
  return (
    <section ref={ref} tabIndex={-1} className="team-checkup" role="dialog" aria-label="Make this team work better" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
      <header>
        <h2>Make this team work better</h2>
        <button type="button" className="iconbtn" onClick={onClose} aria-label="Close suggestions"><X size={15} aria-hidden="true" /></button>
      </header>
      <ul className="checkup-list">
        {findings.map((finding) => (
          <CheckupItem
            key={finding.id} finding={finding} agentName={checkup.names.get(finding.agentId)}
            onOpenAgent={(id) => { onClose(); checkup.onOpenAgent(id) }}
          />
        ))}
      </ul>
      {checkup.hiddenCount > 0 && <footer><button type="button" className="link" onClick={checkup.onRestore}>Show {checkup.hiddenCount} hidden</button></footer>}
    </section>
  )
}
