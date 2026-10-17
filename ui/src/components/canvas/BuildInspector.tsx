import { useRef, useState } from 'react'
import { Puzzle, Trash2, Wrench, X } from 'lucide-react'
import { AgentCheckup } from './AgentCheckup'
import { AgentContext } from './AgentContext'
import { AgentPermissions } from './AgentPermissions'
import { AgentWorkFolder } from './AgentWorkFolder'
import { AgentSpendGuard } from './AgentSpendGuard'
import { AgentUsageLine } from './AgentUsageLine'
import { CheckStep } from './CheckStep'
import { DoneWhen } from './DoneWhen'
import { InstructionShape } from './InstructionShape'
import { InstructionsUpdated } from './InstructionsUpdated'
import { Inspector, type InspectorProps } from './Inspector'
import { LinkedAgent } from './LinkedAgent'
import { SaveAsJob } from './SaveAsJob'
import { ModelPicker } from '../models/ModelPicker'
import { StatusGlyph } from '../ui/glyphs'
import { openRouterId } from '../../lib/ai/modelIds'
import type { SavedJob } from '../../lib/library/jobs'
import type { AgentLinkState } from '../../lib/library/link'
import type { AgentLink } from '../../lib/team-file/types'

/** The agent's versioned link to Your agents, and what the panel may do about it. */
export interface BuildInspectorLink {
  /** `null` for an agent that is this team's own. */
  state: AgentLinkState | null
  onApply: (job: SavedJob) => void
  onUnlink: () => void
  /** "Add to Your agents" made a version of this agent: link to it. */
  onLink: (link: AgentLink) => void
}

export function BuildInspector(props: InspectorProps & { startAdvanced?: boolean; link?: BuildInspectorLink; /** Open this agent on its workbench, in the team's Agents tab. */ onOpenWorkbench?: () => void }) {
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
  // An agent placed from Your agents takes these fields from its version; they change there.
  const locked = readOnly || Boolean(link?.state)
  // The same panel in Build and in a run (ADR 0041); a run adds what this agent is doing in it.
  const runtime = node.data.runtime
  return <aside className="node-inspector" aria-label="Selected node settings" onKeyDown={e => { if (e.key === 'Escape') onClose() }}>
    <div className="inspector-head"><div><span className="eyebrow">{reviewStep ? 'Your review step' : 'Agent'}</span><strong>{node.data.agent.name}</strong>{runtime && <span className="inspector-run-status"><StatusGlyph status={runtime.status} /> {runtime.taskState.toLowerCase()} · {runtime.task}</span>}</div><button className="icon-button" onClick={onClose} aria-label="Close inspector"><X size={15} /></button><button className="icon-button" onClick={onDelete} disabled={readOnly} aria-label={`Remove ${node.data.agent.name}`}><Trash2 size={15} /></button></div>
    <div className="inspector-fields">
      {!reviewStep && props.onOpenWorkbench && <button type="button" className="btn btn-primary inspector-workbench" onClick={props.onOpenWorkbench}><Wrench size={14} aria-hidden="true" />Open its workbench</button>}
      {!reviewStep && linkPanel('build-context-head')}
      <label>Name<input value={node.data.agent.name} disabled={reviewStep ? readOnly : locked} onChange={e => onRename('name', e.target.value)} /></label>
      {/* Instructions are prose; a one-line input hid all but the first few words of them. */}
      <label>{reviewStep ? 'What to check' : 'Instructions'}<textarea ref={roleField} rows={4} className={props.instructionUpdate?.update.state === 'updated' ? 'instructions-marked' : undefined} value={node.data.agent.role} disabled={reviewStep ? readOnly : locked} onChange={e => onRename('role', e.target.value)} placeholder={reviewStep ? 'What should you look at before the team continues?' : 'What should this agent do?'} /></label>
      {props.instructionUpdate && <InstructionsUpdated {...props.instructionUpdate} agent={node.data.agent} readOnly={readOnly} />}
      {!reviewStep && <InstructionShape role={node.data.agent.role} checksDoneWhen={Boolean(node.data.agent.doneWhen?.length)} readOnly={locked} field={roleField} onChange={(role) => onRename('role', role)} />}
      {!reviewStep && props.onDoneWhenChange && <DoneWhen items={node.data.agent.doneWhen ?? []} readOnly={locked} onChange={props.onDoneWhenChange} />}
      {!reviewStep && props.checkStep && <CheckStep {...props.checkStep} readOnly={readOnly} />}
      {!reviewStep && props.checkup && props.checkup.findings.length > 0 && <section className="build-context" aria-label="Make it work better"><AgentCheckup {...props.checkup} readOnly={readOnly} headClassName="build-context-head" /></section>}
      {reviewStep
        ? <p>The team pauses here and waits for you to approve the work or ask for changes.</p>
        : <>
          <ModelPicker value={openRouterId(node.data.agent.model)} disabled={locked} onChange={props.onModelChange} />
          {props.usage && <AgentUsageLine usage={props.usage.agent} runs={props.usage.runs} alone={props.usage.alone} />}
          {props.onSpendChange && <AgentSpendGuard perRun={node.data.agent.spend?.perRun ?? null} readOnly={locked} onChange={props.onSpendChange} />}
          <section className="build-context" aria-label="Context">
            <AgentContext
              agent={node.data.agent} place={props.place} briefCount={props.briefCount} inheritedMemory={props.inheritedMemory} readOnly={readOnly}
              onPromoteEntrypoint={props.onPromoteEntrypoint} onMemoryBriefChange={props.onMemoryBriefChange} onRemoveCapability={props.onRemoveCapability}
              teamPath={props.teamPath} onAddKnowledge={props.onAddKnowledge} onTurnBackOn={props.onTurnBackOn} appHas={props.appHas} onTurnOff={props.onTurnOff} headClassName="build-context-head"
            />
          </section>
          <section className="build-context" aria-label="Works in">
            <AgentWorkFolder agent={node.data.agent} readOnly={readOnly} onChange={props.onCwdChange} problem={props.fieldProblems?.cwd} teamPath={props.teamPath} headClassName="build-context-head" />
          </section>
          <section className="build-context" aria-label="Allowed without asking">
            <AgentPermissions agent={node.data.agent} readOnly={locked} onChange={props.onAllowChange} teamAuto={props.teamAutoMode} headClassName="build-context-head" />
          </section>
          <p><Puzzle size={13} />Skills you connect open when the work calls for them. <a className="link" href="/skills">Manage skills</a></p>
          <button className="btn" onClick={() => setAdvanced(true)}>Thinking effort and more settings</button>
          {!link?.state && <SaveAsJob key={node.id} agent={node.data.agent} onLinked={readOnly ? undefined : link?.onLink} />}
        </>}
    </div>
  </aside>
}
