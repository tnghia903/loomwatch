import { ChevronDown } from '../ui/icon'
import { useEffect, useRef, useState } from 'react'

import { shortName } from '../../lib/ai/client'
import { modelNameFromId } from '../../lib/ai/modelIds'
import { useModels } from '../../lib/ai/useModels'
import { ModelChoices } from '../models/ModelPicker'

interface AskModelPickerProps {
  /** The model shown as in use: the live conversation's, else the next one's. */
  model: string
  /** A conversation is under way, so a change starts a new one. */
  inConversation: boolean
  disabled?: boolean
  onChoose: (model: string) => void
}

/**
 * "Using [Claude Opus 5.5 ⌄]", where the model is a button: the person picks the model Ask runs on,
 * from the same list the agents' picker shows.
 */
export function AskModelPicker({ model, inConversation, disabled = false, onChoose }: AskModelPickerProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const { catalog } = useModels()
  const listed = catalog?.models.find((item) => item.id === model)
  const label = listed ? shortName(listed) : modelNameFromId(model)

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    return () => window.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const close = () => { setOpen(false); toggle.current?.focus() }

  return (
    <div
      ref={root}
      className="ask-app"
      onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.stopPropagation(); close() } }}
    >
      <button
        ref={toggle}
        type="button"
        className="ask-app-toggle"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Model: ${label}. Change`}
        title="Choose the model Ask runs on"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="ask-app-name">{label}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div role="dialog" aria-label="Choose the model Ask runs on" className="pop e2 ask-app-pop ask-model-pop">
          <ModelChoices value={model} onPick={(id) => { if (id !== model) onChoose(id); close() }} />
          {inConversation && <p className="pop-note t-meta ask-app-note">Changing the model starts a new conversation.</p>}
        </div>
      )}
    </div>
  )
}
