import { useRef, useState, type ReactNode } from 'react'
import { Trash2, Wrench, X } from 'lucide-react'
import { AgentCheckup } from './AgentCheckup'
import { AgentContext } from './AgentContext'
import { AgentWorkFolder } from './AgentWorkFolder'
import { AgentWorkflowPlace } from './AgentWorkflowPlace'
import { AgentSpendGuard } from './AgentSpendGuard'
import { AgentUsageLine } from './AgentUsageLine'
import { CheckStep } from './CheckStep'
import { InstructionsUpdated } from './InstructionsUpdated'
import { Inspector, type InspectorProps } from './Inspector'
import { LinkedAgent } from './LinkedAgent'
import { FigureStill } from '../agents/FigureStill'
import { StatusGlyph } from '../ui/glyphs'
import type { FigureChoice } from '../../lib/library/figures'
import { modelLabelForAgent } from '../../lib/models'
import type { JobSpec, SavedJob } from '../../lib/library/jobs'
import type { AgentLinkState } from '../../lib/library/link'

/** The agent's versioned link to Your agents, and what the panel may do about it. */
export interface BuildInspectorLink {
  /** `null` for an agent that is this team's own. */
  state: AgentLinkState | null
  onApply: (job: SavedJob, previous: JobSpec | null) => void
  onUnlink: () => void
}

export function BuildInspector(props: InspectorProps & {
  startAdvanced?: boolean
  link?: BuildInspectorLink
  /** Open this agent on its workbench, in the team's Agents tab. */
  onOpenWorkbench?: () => void
  /** The figure each agent wears, for the agent and its neighbours. */
  figures?: ReadonlyMap<string, FigureChoice>
  /** Select another card and bring it into view. */
  onFocusAgent?: (id: string) => void
}) {
  const roleField = useRef<HTMLTextAreaElement>(null)
  const [advanced, setAdvanced] = useState(Object.keys(props.fieldProblems ?? {}).length > 0 || props.startAdvanced === true)
  const { node, onRename, onClose, onDelete, readOnly } = props
  // Something sent the operator to a field — an alert's Fix, a problem in the list. The short panel
  // does not contain most fields, so it opens the full one, including when this panel is already
  // open for the same agent (Build and a run share it, ADR 0041). It never folds it back.
  const forced = props.startAdvanced === true
  const [wasForced, setWasForced] = useState(forced)
  if (forced !== wasForced) {
    setWasForced(forced)
    if (forced) setAdvanced(true)
  }
  const link = props.link
  const linkPanel = (headClassName: string) => link?.state ? <LinkedAgent agent={node.data.agent} link={link.state} readOnly={readOnly} onApply={link.onApply} onUnlink={link.onUnlink} teamPath={props.teamPath} headClassName={headClassName} /> : undefined
  if (advanced) return <div className="advanced-node-settings"><Inspector {...props} linked={linkPanel('zone-head t-micro')} onClose={() => setAdvanced(false)} /></div>
  const reviewStep = node.data.agent.kind === 'operator'
  // The same panel in Build and in a run (ADR 0041); a run adds what this agent is doing in it.
  const runtime = node.data.runtime
  const head = (eyebrow: string, face?: ReactNode) => <div className="inspector-head">{face}<div><span className="eyebrow">{eyebrow}</span><strong>{node.data.agent.name}</strong>{runtime && <span className="inspector-run-status"><StatusGlyph status={runtime.status} /> {runtime.taskState.toLowerCase()} · {runtime.task}</span>}</div><button className="icon-button" onClick={onClose} aria-label="Close inspector"><X size={15} /></button><button className="icon-button" onClick={onDelete} disabled={readOnly} aria-label={`Remove ${node.data.agent.name}`}><Trash2 size={15} /></button></div>
  if (reviewStep) {
    // A review stop is a person, not an agent: it has no workbench, so what it checks is set here.
    return <aside className="node-inspector" aria-label="Selected node settings" onKeyDown={e => { if (e.key === 'Escape') onClose() }}>
      {head('Your review step')}
      <div className="inspector-fields">
        <label>Name<input value={node.data.agent.name} disabled={readOnly} onChange={e => onRename('name', e.target.value)} /></label>
        <label>What to check<textarea ref={roleField} rows={4} value={node.data.agent.role} disabled={readOnly} onChange={e => onRename('role', e.target.value)} placeholder="What should you look at before the team continues?" /></label>
        <p>The team pauses here and waits for you to approve the work or ask for changes.</p>
      </div>
    </aside>
  }
  // Everything about the agent itself (its name, instructions, Done when, model, effort, skills,
  // tools and what it may do) is on its workbench, so it is not said twice here. This panel is the
  // agent in this team: where it sits in the workflow, what the team gives it, and what only a team
  // decides, like where it works and what a run may spend.
  const figure = props.figures?.get(node.id)
  // An agent placed from My agents takes its spend limit from its version; it changes there.
  const locked = readOnly || Boolean(link?.state)
  return <aside className="node-inspector agent-in-team" aria-label="Selected node settings" onKeyDown={e => { if (e.key === 'Escape') onClose() }}>
    {head(node.data.modelLabel ?? modelLabelForAgent(node.data.agent), figure ? <FigureStill className="inspector-figure" figure={figure} headOnly alt="" /> : undefined)}
    <div className="inspector-fields">
      {props.onOpenWorkbench && <button type="button" className="btn btn-primary inspector-workbench" onClick={props.onOpenWorkbench} title="Its name, instructions, model, skills, tools and what it may do"><Wrench size={14} aria-hidden="true" />Open its workbench</button>}
      {linkPanel('build-context-head')}
      {props.instructionUpdate && <InstructionsUpdated {...props.instructionUpdate} agent={node.data.agent} readOnly={readOnly} />}
      {props.place && <AgentWorkflowPlace agentId={node.id} name={node.data.agent.name} place={props.place} figures={props.figures} onFocus={props.onFocusAgent} onPromoteEntrypoint={props.onPromoteEntrypoint} readOnly={readOnly} />}
      {props.checkStep && <CheckStep {...props.checkStep} readOnly={readOnly} />}
      {props.checkup && props.checkup.findings.length > 0 && <section className="build-context" aria-label="Make it work better"><AgentCheckup {...props.checkup} readOnly={readOnly} headClassName="build-context-head" /></section>}
      <section className="build-context" aria-label="Context">
        <AgentContext
          agent={node.data.agent} briefCount={props.briefCount} inheritedMemory={props.inheritedMemory} readOnly={readOnly}
          pipeline={props.pipeline} onAllowRecruitingChange={props.onAllowRecruitingChange}
          onMemoryBriefChange={props.onMemoryBriefChange} onRemoveCapability={props.onRemoveCapability}
          teamPath={props.teamPath} onAddKnowledge={props.onAddKnowledge} onTurnBackOn={props.onTurnBackOn} appHas={props.appHas} onTurnOff={props.onTurnOff} headClassName="build-context-head"
        />
      </section>
      <section className="build-context" aria-label="Works in">
        <AgentWorkFolder agent={node.data.agent} readOnly={readOnly} onChange={props.onCwdChange} problem={props.fieldProblems?.cwd} teamPath={props.teamPath} headClassName="build-context-head" />
      </section>
      {props.onSpendChange && <AgentSpendGuard perRun={node.data.agent.spend?.perRun ?? null} readOnly={locked} onChange={props.onSpendChange} />}
      {props.usage && <AgentUsageLine usage={props.usage.agent} runs={props.usage.runs} alone={props.usage.alone} />}
    </div>
  </aside>
}
