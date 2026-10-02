import { useState, type ComponentProps } from 'react'
import { Trash2, X } from 'lucide-react'
import { CapabilityInspector } from './CapabilityInspector'

export function BuildResourceInspector(props: ComponentProps<typeof CapabilityInspector> & { onRemove?: () => void }) {
  const [details, setDetails] = useState(false)
  if (details) return <CapabilityInspector {...props} onClose={() => setDetails(false)} />
  // A knowledge card that is not memory was placed from the Library before ADR 0036 and is never
  // delivered: knowledge is a folder or file chosen in the agent's Context.
  const note = props.kind === 'knowledge' && !props.item.memory
    ? 'Not delivered. Knowledge is now a folder or file you choose: select the agent and use Add folder… or Add file… in its Context, then remove this card.'
    : 'Wire this node from a harness to include it in that agent’s plan.'
  return <aside className="node-inspector" aria-label="Selected resource settings"><div className="inspector-head"><div><span className="eyebrow">Selected {props.kind}</span><strong>{props.item.name}</strong></div><button className="icon-button" aria-label="Close capability details" onClick={props.onClose}><X size={15} /></button>{props.onRemove && <button className="icon-button" aria-label={`Remove ${props.item.name}`} onClick={props.onRemove} disabled={props.readOnly}><Trash2 size={15} /></button>}</div><div className="inspector-readonly"><span>{props.item.source}</span><p>{note}</p><button className="btn" onClick={() => setDetails(true)}>Details & connections</button></div></aside>
}
