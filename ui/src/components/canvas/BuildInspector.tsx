import { useState } from 'react'
import { Puzzle, Trash2, X } from 'lucide-react'
import { Inspector, type InspectorProps } from './Inspector'
import type { DetectedHarness } from '../../lib/harnesses'

export function BuildInspector(props: InspectorProps & { harnesses?: DetectedHarness[]; harnessId?: string; onHarnessChange?: (id: string) => void; startAdvanced?: boolean }) {
  const [advanced, setAdvanced] = useState(Object.keys(props.fieldProblems ?? {}).length > 0 || props.startAdvanced === true)
  const { node, onRename, onClose, onDelete, readOnly, harnesses = [], harnessId, onHarnessChange } = props
  // `startAdvanced` is read once, on mount, and that is the only moment it can arrive: leaving a
  // run for Build swaps the run Inspector for this one, so the panel is always new when something
  // sends the operator to a field. The short panel does not contain most fields, so opening it
  // first would hide the thing they came for.
  if (advanced) return <div className="advanced-node-settings"><Inspector {...props} onClose={() => setAdvanced(false)} /></div>
  const reviewStep = node.data.agent.kind === 'operator'
  return <aside className="node-inspector" aria-label="Selected node settings" onKeyDown={e => { if (e.key === 'Escape') onClose() }}>
    <div className="inspector-head"><div><span className="eyebrow">{reviewStep ? 'Your review step' : 'Agent'}</span><strong>{node.data.agent.name}</strong></div><button className="icon-button" onClick={onClose} aria-label="Close inspector"><X size={15} /></button><button className="icon-button" onClick={onDelete} disabled={readOnly} aria-label={`Remove ${node.data.agent.name}`}><Trash2 size={15} /></button></div>
    <div className="inspector-fields">
      <label>Name<input value={node.data.agent.name} disabled={readOnly} onChange={e => onRename('name', e.target.value)} /></label>
      {/* Instructions are prose; a one-line input hid all but the first few words of them. */}
      <label>{reviewStep ? 'What to check' : 'Instructions'}<textarea rows={4} value={node.data.agent.role} disabled={readOnly} onChange={e => onRename('role', e.target.value)} placeholder={reviewStep ? 'What should you look at before the team continues?' : 'What should this agent do?'} /></label>
      {reviewStep
        ? <p>The team pauses here and waits for you to approve the work or ask for changes.</p>
        : <>
          <label>AI app<select value={harnessId ?? ''} disabled={readOnly} onChange={e => onHarnessChange?.(e.target.value)}><option value="" disabled>Choose an app</option>{harnesses.map(h => <option key={h.id} value={h.id} disabled={h.acpAvailable === false}>{h.name}</option>)}</select></label>
          <p><Puzzle size={13} />Skills you connect work with any AI app.</p>
          <button className="btn" onClick={() => setAdvanced(true)}>Model and more settings</button>
        </>}
    </div>
  </aside>
}
