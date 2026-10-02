import { X } from 'lucide-react'

import type { AgentNode } from '../../lib/library/nodeFromDrop'
import type { DeliverConfig } from '../../lib/team-file/types'
import { NotionDeliverySettings } from './NotionDeliverySettings'

type OutputPlan = { name: string; format: string }

const DEFAULT_OUTPUT: OutputPlan = { name: 'Team response', format: 'Markdown report' }

interface OutputEditorProps {
  /** The planned deliverable, from the layout sidecar; absent until the operator names one. */
  output: OutputPlan | undefined
  onOutputChange: (output: OutputPlan) => void
  /** The sidecar write is in flight. */
  saving: boolean
  responder: string | null
  agents: readonly AgentNode[]
  /** Only a pipeline names its responder; in team mode the entrypoint answers. */
  canChooseResponder: boolean
  onPromoteResponder: (id: string) => void
  onClose: () => void
  /** Where every answer goes besides this window (ADR 0038). Absent: the section is not offered. */
  delivery?: {
    deliver: DeliverConfig | null
    onChange: (deliver: DeliverConfig | null) => void
    readOnly: boolean
    teamName: string
    routineTitle: string | null
  }
}

/** The settings of the selected Output node in Build: what the next run delivers, and who. */
export function OutputEditor({ output, onOutputChange, saving, responder, agents, canChooseResponder, onPromoteResponder, onClose, delivery }: OutputEditorProps) {
  return (
    <aside className="node-inspector" aria-label="Selected output settings">
      <div className="inspector-head">
        <div><span className="eyebrow">Selected output</span><strong>{output?.name || DEFAULT_OUTPUT.name}</strong></div>
        <button className="icon-button" aria-label="Close output settings" onClick={onClose}><X size={16} /></button>
      </div>
      <div className="inspector-fields">
        <label>Deliverable name<input value={output?.name ?? DEFAULT_OUTPUT.name} onChange={(event) => onOutputChange({ name: event.target.value, format: output?.format ?? DEFAULT_OUTPUT.format })} /></label>
        <label>Format<select value={output?.format ?? DEFAULT_OUTPUT.format} onChange={(event) => onOutputChange({ name: output?.name ?? DEFAULT_OUTPUT.name, format: event.target.value })}><option>Markdown report</option><option>HTML dashboard</option><option>Document and files</option></select></label>
        <label>Produced by<select value={responder ?? ''} disabled={!canChooseResponder} onChange={(event) => onPromoteResponder(event.target.value)}>{agents.map((node) => <option key={node.id} value={node.id}>{node.data.agent.name}</option>)}</select></label>
        <p>Connect the final harness to make its ownership explicit.</p>
        <small>{saving ? 'Saving…' : 'Applies to the next new run.'}</small>
        {delivery && <NotionDeliverySettings {...delivery} />}
      </div>
    </aside>
  )
}
