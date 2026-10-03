import { useState } from 'react'
import { Puzzle, Trash2, X } from 'lucide-react'
import { AgentContext } from './AgentContext'
import { AgentPermissions } from './AgentPermissions'
import { AgentWorkFolder } from './AgentWorkFolder'
import { Inspector, type InspectorProps } from './Inspector'
import { SaveAsJob } from './SaveAsJob'
import { StatusGlyph } from '../ui/glyphs'
import type { DetectedHarness } from '../../lib/harnesses'

export function BuildInspector(props: InspectorProps & { harnesses?: DetectedHarness[]; harnessId?: string; onHarnessChange?: (id: string) => void; startAdvanced?: boolean }) {
  const [advanced, setAdvanced] = useState(Object.keys(props.fieldProblems ?? {}).length > 0 || props.startAdvanced === true)
  const { node, onRename, onClose, onDelete, readOnly, harnesses = [], harnessId, onHarnessChange } = props
  // Something sent the operator to a field — an alert's Fix, a problem in the list. The short panel
  // does not contain most fields, so it opens the full one, including when this panel is already
  // open for the same agent (Build and a run share it, ADR 0041). It never folds it back.
  const forced = props.startAdvanced === true
  const [wasForced, setWasForced] = useState(forced)
  if (forced !== wasForced) {
    setWasForced(forced)
    if (forced) setAdvanced(true)
  }
  if (advanced) return <div className="advanced-node-settings"><Inspector {...props} onClose={() => setAdvanced(false)} /></div>
  const reviewStep = node.data.agent.kind === 'operator'
  // The same panel in Build and in a run (ADR 0041); a run adds what this agent is doing in it.
  const runtime = node.data.runtime
  return <aside className="node-inspector" aria-label="Selected node settings" onKeyDown={e => { if (e.key === 'Escape') onClose() }}>
    <div className="inspector-head"><div><span className="eyebrow">{reviewStep ? 'Your review step' : 'Agent'}</span><strong>{node.data.agent.name}</strong>{runtime && <span className="inspector-run-status"><StatusGlyph status={runtime.status} /> {runtime.taskState.toLowerCase()} · {runtime.task}</span>}</div><button className="icon-button" onClick={onClose} aria-label="Close inspector"><X size={15} /></button><button className="icon-button" onClick={onDelete} disabled={readOnly} aria-label={`Remove ${node.data.agent.name}`}><Trash2 size={15} /></button></div>
    <div className="inspector-fields">
      <label>Name<input value={node.data.agent.name} disabled={readOnly} onChange={e => onRename('name', e.target.value)} /></label>
      {/* Instructions are prose; a one-line input hid all but the first few words of them. */}
      <label>{reviewStep ? 'What to check' : 'Instructions'}<textarea rows={4} value={node.data.agent.role} disabled={readOnly} onChange={e => onRename('role', e.target.value)} placeholder={reviewStep ? 'What should you look at before the team continues?' : 'What should this agent do?'} /></label>
      {reviewStep
        ? <p>The team pauses here and waits for you to approve the work or ask for changes.</p>
        : <>
          <label>AI app<select value={harnessId ?? ''} disabled={readOnly} onChange={e => onHarnessChange?.(e.target.value)}><option value="" disabled>Choose an app</option>{harnesses.map(h => <option key={h.id} value={h.id} disabled={h.acpAvailable === false}>{h.name}</option>)}</select></label>
          <section className="build-context" aria-label="Context">
            <span className="build-context-head">Context</span>
            <AgentContext
              agent={node.data.agent} place={props.place} briefCount={props.briefCount} inheritedMemory={props.inheritedMemory} readOnly={readOnly}
              onPromoteEntrypoint={props.onPromoteEntrypoint} onMemoryBriefChange={props.onMemoryBriefChange} onRemoveCapability={props.onRemoveCapability}
              teamPath={props.teamPath} onAddKnowledge={props.onAddKnowledge}
            />
          </section>
          <section className="build-context" aria-label="Works in">
            <span className="build-context-head">Works in</span>
            <AgentWorkFolder agent={node.data.agent} readOnly={readOnly} onChange={props.onCwdChange} problem={props.fieldProblems?.cwd} teamPath={props.teamPath} />
          </section>
          <section className="build-context" aria-label="Allowed without asking">
            <span className="build-context-head">Allowed without asking</span>
            <AgentPermissions agent={node.data.agent} readOnly={readOnly} onChange={props.onAllowChange} />
          </section>
          <p><Puzzle size={13} />Skills you connect work with any AI app.</p>
          <button className="btn" onClick={() => setAdvanced(true)}>Model and more settings</button>
          <SaveAsJob key={node.id} agent={node.data.agent} appId={harnessId} />
        </>}
    </div>
  </aside>
}
