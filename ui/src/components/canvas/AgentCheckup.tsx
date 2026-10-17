import { CircleAlert, History, Lightbulb, Wand2 } from 'lucide-react'

import type { CheckupFinding } from '../../lib/team-file/checkup'
import { SectionHead } from '../ui/SectionHead'

/** What the panel can do with a finding. Absent actions are not offered. */
export interface CheckupActions {
  /** Apply the finding's one-click fix. */
  onFix?: (finding: CheckupFinding) => void
  /** Hide it for this team: the operator knows better. */
  onDismiss?: (finding: CheckupFinding) => void
  /** Ask LoomWatch for an edit only judgement can make; absent when Ask can't answer (no OpenRouter key). */
  onAsk?: (prompt: string) => void
  /** Open the agent a finding is about. The agent's own panel leaves this out. */
  onOpenAgent?: (agentId: string) => void
}

export interface CheckupItemProps extends CheckupActions {
  finding: CheckupFinding
  readOnly?: boolean
  /** Name of the agent `onOpenAgent` opens, for its label. */
  agentName?: string
}

/** One finding: what would go better, why in a sentence, and what to do about it. */
export function CheckupItem({ finding, readOnly = false, agentName, onFix, onDismiss, onAsk, onOpenAgent }: CheckupItemProps) {
  const Mark = finding.severity === 'fix' ? CircleAlert : Lightbulb
  const fix = !readOnly && onFix && finding.fix
  const ask = !readOnly && onAsk && finding.askPrompt
  return (
    <li className={`checkup-item ${finding.severity}`} data-rule={finding.rule}>
      <Mark className="checkup-mark" size={14} aria-hidden="true" />
      <div className="checkup-body">
        {finding.learned !== undefined && <div className="checkup-learned"><History size={11} aria-hidden="true" />From the last {finding.learned === 1 ? 'run' : `${finding.learned} runs`}</div>}
        <b className="checkup-title">{finding.title}</b>
        <div className="checkup-why">{finding.why}</div>
        {(fix || ask || onOpenAgent || (!readOnly && onDismiss)) && (
          <div className="checkup-actions">
            {fix && <button type="button" className="btn checkup-fix" onClick={() => onFix(finding)}>{finding.fix?.label}</button>}
            {ask && <button type="button" className="btn checkup-ask" onClick={() => onAsk(finding.askPrompt as string)}><Wand2 size={13} aria-hidden="true" />Ask LoomWatch to rewrite</button>}
            {onOpenAgent && <button type="button" className="link" onClick={() => onOpenAgent(finding.agentId)}>Open {agentName ?? 'agent'}</button>}
            {!readOnly && onDismiss && <button type="button" className="link checkup-dismiss" onClick={() => onDismiss(finding)} title="Hide this suggestion for this team">Not needed</button>}
          </div>
        )}
      </div>
    </li>
  )
}

export interface AgentCheckupProps extends Omit<CheckupActions, 'onOpenAgent'> {
  findings: readonly CheckupFinding[]
  readOnly?: boolean
  /** The heading's look in the panel that shows it. */
  headClassName?: string
}

/**
 * MAKE IT WORK BETTER: the team checkup's findings about this agent (lib/team-file/checkup.ts).
 * Shown only when there is something to say, under the instructions it is mostly about, so a
 * well-set-up agent's panel is no longer than before.
 */
export function AgentCheckup({ findings, readOnly = false, headClassName, ...actions }: AgentCheckupProps) {
  if (findings.length === 0) return null
  return (
    <div className="agent-context agent-checkup">
      <SectionHead title="Make it work better" className={headClassName} explain={<>
        <div>LoomWatch reads this agent’s instructions, its place in the team and what it may do, and the team’s last few runs, and suggests what would make its work better. Nothing changes until you choose a fix, and ⌘Z undoes one.</div>
        <div><b>Not needed</b> hides a suggestion for this team.</div>
      </>} />
      <ul className="checkup-list">
        {findings.map((finding) => <CheckupItem key={finding.id} finding={finding} readOnly={readOnly} {...actions} />)}
      </ul>
    </div>
  )
}
