import { useId, useMemo, useState } from 'react'

import { type Model, contextSize, price, shortName } from '../../lib/ai/client'
import { useModels } from '../../lib/ai/useModels'

const MAX_RESULTS = 40

function vendor(id: string): string {
  return id.split('/')[0] ?? ''
}

function Row({ model, selected, onPick }: { model: Model; selected: boolean; onPick: (id: string) => void }) {
  return (
    <li>
      <button type="button" role="option" aria-selected={selected} className={`pop-row model-row ${selected ? 'current' : ''}`} onClick={() => onPick(model.id)}>
        <span className="name t-body">{shortName(model)}</span>
        <span className="aside t-meta">
          {model.free ? <span className="badge">Free</span> : `${price(model.inputPrice)} in · ${price(model.outputPrice)} out`}
        </span>
        <span className="t-meta model-row-detail">
          {model.note ? `${model.note} · ` : ''}{vendor(model.id)} · {contextSize(model.contextLength)} context
        </span>
      </button>
    </li>
  )
}

/**
 * Chooses the model an agent runs on. The recommended few come first, with why; everything
 * OpenRouter lists that can use tools is a search away. Prices are per million tokens, the way
 * OpenRouter shows them.
 */
export function ModelPicker({ value, onChange, label = 'Model' }: { value: string; onChange: (id: string) => void; label?: string }) {
  const { catalog, error } = useModels()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const listId = useId()

  const current = catalog?.models.find((model) => model.id === value)
  const found = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!catalog || words.length === 0) return []
    return catalog.models
      .filter((model) => words.every((word) => `${model.id} ${model.name}`.toLowerCase().includes(word)))
      .slice(0, MAX_RESULTS)
  }, [catalog, query])

  function pick(id: string) {
    onChange(id)
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="model-picker field">
      <span className="t-meta">{label}</span>
      <button type="button" className="input model-picker-current" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
        <span className="t-body">{current ? shortName(current) : value || 'Choose a model'}</span>
        {current && <span className="t-meta lw-settings-quiet">{current.free ? 'Free' : `${price(current.inputPrice)} / ${price(current.outputPrice)} per million tokens`}</span>}
        {!current && value && catalog && <span className="t-meta inline-error">Not in OpenRouter’s list</span>}
      </button>
      {open && <div className="e2 model-picker-pop" id={listId}>
        {error && <p role="alert" className="inline-error t-meta">{error}</p>}
        {!catalog && !error && <p role="status" className="t-meta lw-settings-quiet">Loading models…</p>}
        {catalog && <>
          <label className="field">
            <span className="t-meta">Search all {catalog.models.length} models</span>
            <input className="input" value={query} placeholder="claude, gpt, gemini, free…" onChange={(event) => setQuery(event.target.value)} autoFocus />
          </label>
          <ul className="pop-list" role="listbox" aria-label={query ? 'Models found' : 'Recommended models'}>
            {(query ? found : catalog.recommended).map((model) => <Row key={model.id} model={model} selected={model.id === value} onPick={pick} />)}
          </ul>
          {query && found.length === 0 && <p className="t-meta lw-settings-quiet">No model matches. Try another word.</p>}
          {!query && <p className="t-meta lw-settings-quiet">Free models are limited per day, and their makers may learn from what you send. Keep private work on a paid model.</p>}
        </>}
      </div>}
    </div>
  )
}
