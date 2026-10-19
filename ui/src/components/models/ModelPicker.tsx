import { Check, ChevronDown, Sparkles } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { type Model, contextSize, price, shortName } from '../../lib/ai/client'
import { makerOf } from '../../lib/ai/makers'
import { OFFLINE_MODEL, modelNameFromId, parseModelRef } from '../../lib/ai/modelIds'
import { useSetupReading } from '../../lib/ai/reading'
import { useModels } from '../../lib/ai/useModels'
import { type ModelSuggestionInput, suggestModel } from '../../lib/team-file/modelSuggestion'
import { MakerMark } from './MakerMark'
import { AiChoice } from './AiChoice'

const MAX_RESULTS = 40

function Row({ id, model, selected, active, why, plain = false, follow, onPoint, onPick }: {
  id: string
  model: Model
  selected: boolean
  active: boolean
  /** In place of the model's own note: why it suits this agent. */
  why?: string
  /** A button, not one of the list's options: the suggestion while the list shows search results. */
  plain?: boolean
  /** On the suggestion of an agent that could follow it: what picking it does. */
  follow?: string
  onPoint: () => void
  onPick: (id: string) => void
}) {
  const maker = makerOf(model.id)
  return (
    <button id={id} type="button" {...(plain ? {} : { role: 'option', 'aria-selected': selected })} title={follow} aria-description={follow} className={`pop-row model-row ${selected ? 'current' : ''} ${active ? 'active' : ''}`} onMouseMove={onPoint} onClick={() => onPick(model.id)}>
      <span className="model-row-mark">
        <MakerMark maker={maker} />
        {selected && <span className="model-row-tick" aria-hidden="true"><Check size={10} strokeWidth={3} /></span>}
      </span>
      <span className="name t-body">{shortName(model)}</span>
      <span className="aside t-meta">
        {model.free ? <span className="badge">Free</span> : `${price(model.inputPrice)} in · ${price(model.outputPrice)} out`}
      </span>
      <span className={`t-meta model-row-detail ${why ? 'model-row-why' : ''}`}>
        {why ?? <>{model.note ? `${model.note} · ` : ''}{maker.name} · {contextSize(model.contextLength)} context</>}
      </span>
    </button>
  )
}

/**
 * The models to choose from: the one suggested for this agent first, with why, then the
 * recommended few, and everything OpenRouter lists that can use tools a search away. The arrow keys
 * move through them and Enter picks, as in the command palette. Prices are per million tokens, the
 * way OpenRouter shows them.
 *
 * `suggestFor` is the agent and its team (modelSuggestion.ts). Its suggestion is a card of its own
 * at the top, above the search, so it stands apart whether or not it is the model in use and stays
 * put while you search or scroll. Along its foot, for an agent its name doesn't place, are how sure
 * the suggestion is and Let AI choose (AiChoice.tsx). The card is outside the listbox, as a control
 * can't be one of its options; `aria-owns` keeps the suggested row first among them, and while the
 * list shows search results it is a plain button.
 *
 * `follows` says whether the agent's model follows its suggestion (ADR 0072); absent where following
 * isn't offered. Picking the suggestion has the agent follow it, and picking any other model pins
 * it: `onPick`'s second value.
 */
export function ModelChoices({ value, suggestFor, follows, onPick }: { value: string; suggestFor?: ModelSuggestionInput; follows?: boolean; onPick: (id: string, follow: boolean) => void }) {
  const { catalog, error } = useModels()
  const read = useSetupReading(suggestFor?.agent, Boolean(suggestFor))
  const suggestion = suggestFor ? suggestModel({ ...suggestFor, reading: read.reading }) : undefined
  const [query, setQuery] = useState('')
  const listId = useId()
  const found = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!catalog || words.length === 0) return []
    return catalog.models
      .filter((model) => words.every((word) => `${model.id} ${model.name}`.toLowerCase().includes(word)))
      .slice(0, MAX_RESULTS)
  }, [catalog, query])
  // Shown only when the list has it: a suggestion is a price and a pick, never a dead row.
  const suggested = suggestion && catalog?.models.find((model) => model.id === suggestion.model)
  const others = catalog ? catalog.recommended.filter((model) => model.id !== suggested?.id) : []
  const rows = query ? found : [...(suggested ? [suggested] : []), ...others]
  const startAt = (list: readonly Model[]) => Math.max(0, list.findIndex((model) => model.id === value))
  const [activeIndex, setActiveIndex] = useState(() => startAt(rows))
  // The list arrives after the picker opens the first time, so the chosen model is found then; a
  // reading that arrives later can move the suggestion, and the rows with it.
  const [startedOn, setStartedOn] = useState({ catalog, suggested: suggested?.id })
  if (startedOn.catalog !== catalog || startedOn.suggested !== suggested?.id) { setStartedOn({ catalog, suggested: suggested?.id }); setActiveIndex(startAt(rows)) }
  const optionId = (index: number) => `${listId}-${index}`

  function pick(id: string, follow = false) {
    onPick(id, follow)
    setQuery('')
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (rows.length === 0) return
      const next = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
      setActiveIndex(next)
      document.getElementById(optionId(next))?.scrollIntoView?.({ block: 'nearest' })
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const model = rows[activeIndex]
      if (model) pick(model.id, !query && Boolean(suggested) && activeIndex === 0)
    }
  }

  const followNote = follows === false ? 'Pick it, and this agent’s model follows its configuration from now on.' : undefined
  const row = (model: Model, index: number, why?: string) => (
    <Row key={model.id} id={optionId(index)} model={model} selected={model.id === value} active={index === activeIndex} why={why} follow={why ? followNote : undefined} onPoint={() => setActiveIndex(index)} onPick={(id) => pick(id, Boolean(why))} />
  )

  return (
    <>
      {error && <p role="alert" className="inline-error t-meta">{error}</p>}
      {!catalog && !error && <p role="status" className="t-meta lw-settings-quiet">Loading models…</p>}
      {catalog && <>
        {suggested && <div className="model-suggestion">
          <div className="model-suggestion-head">
            <p className="model-group-head t-micro" id={`${listId}-suggested`}><Sparkles size={11} aria-hidden="true" />Suggested for this agent</p>
            {follows && <span className="t-micro model-follow-note">Follows its configuration</span>}
          </div>
          <div className="model-group" role="group" id={`${listId}-suggested-group`} aria-labelledby={`${listId}-suggested`}>
            {query
              ? <Row id={`${listId}-suggested-row`} model={suggested} selected={suggested.id === value} active={false} why={suggestion?.why} plain follow={followNote} onPoint={() => {}} onPick={(id) => pick(id, true)} />
              : row(suggested, 0, suggestion?.why)}
          </div>
          {suggestFor && <AiChoice agent={suggestFor.agent} read={read} />}
        </div>}
        <label className="field">
          <span className="t-meta">Search all {catalog.models.length} models</span>
          <input
            className="input" value={query} placeholder="claude, gpt, gemini, free…" autoFocus
            role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
            aria-activedescendant={rows[activeIndex] ? optionId(activeIndex) : undefined}
            onChange={(event) => {
              const next = event.target.value
              setQuery(next)
              setActiveIndex(next.trim() ? 0 : startAt([...(suggested ? [suggested] : []), ...others]))
            }}
            onKeyDown={onKeyDown}
          />
        </label>
        <div className="pop-list model-list" role="listbox" id={listId} aria-label={query ? 'Models found' : 'Recommended models'} aria-owns={!query && suggested ? `${listId}-suggested-group ${listId}-others` : undefined}>
          {query ? found.map((model, index) => row(model, index)) : suggested ? (
            <div className="model-group" role="group" id={`${listId}-others`} aria-labelledby={`${listId}-others-head`}>
              <p className="model-group-head t-micro" id={`${listId}-others-head`}>Other good models</p>
              {others.map((model, index) => row(model, index + 1))}
            </div>
          ) : others.map((model, index) => row(model, index))}
        </div>
        {query && found.length === 0 && <p className="t-meta lw-settings-quiet">No model matches. Try another word.</p>}
        {!query && <p className="t-meta lw-settings-quiet">Free models are limited per day, and their makers may learn from what you send. Keep private work on a paid model.</p>}
      </>}
    </>
  )
}

/**
 * Chooses the model an agent runs on. `field` marks the button as that team-file field, so a
 * problem with it can take the operator straight there. `suggestFor` is the agent and its team: the
 * model its job and place suit (modelSuggestion.ts) is listed first, with why.
 */
export function ModelPicker({ value, onChange, label = 'Model', disabled = false, field, suggestFor, follows, moved }: {
  value: string
  /** The model picked, and whether the agent now follows its suggestion (ADR 0072). */
  onChange: (id: string, follow: boolean) => void
  label?: string
  disabled?: boolean
  field?: string
  suggestFor?: ModelSuggestionInput
  /** Whether its model follows its suggestion; absent where following isn't offered. */
  follows?: boolean
  /** Its model just moved with its configuration: from what, and how to put it back. */
  moved?: { from: string; onUndo: () => void }
}) {
  const { catalog } = useModels()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const labelId = useId()
  const nameId = useId()
  const suggestedId = useId()
  const current = catalog?.models.find((model) => model.id === value)

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
    <div ref={root} className="model-picker field" onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.stopPropagation(); close() } }}>
      <span className="t-meta" id={labelId}>{label}</span>
      <button ref={toggle} type="button" className="input model-picker-current" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} aria-labelledby={`${labelId} ${nameId}${follows ? ` ${suggestedId}` : ''}`} data-agent-field={field} disabled={disabled} onClick={() => setOpen(!open)}>
        {value && value !== OFFLINE_MODEL && (value.includes('/') || parseModelRef(value).source !== 'openrouter') && <MakerMark maker={makerOf(value)} />}
        <span className="model-picker-text">
          <span className="t-body" id={nameId}>{current ? shortName(current) : value ? modelNameFromId(value) : 'Choose a model'}</span>
          {current && <span className="t-meta lw-settings-quiet">{current.free ? 'Free' : `${price(current.inputPrice)} / ${price(current.outputPrice)} per million tokens`}</span>}
          {!current && value && value !== OFFLINE_MODEL && catalog && parseModelRef(value).source === 'openrouter' && <span className="t-meta inline-error">Not in OpenRouter’s list</span>}
        </span>
        {follows && <span className="model-picker-suggested t-meta" id={suggestedId}><Sparkles size={11} aria-hidden="true" />Suggested</span>}
        <ChevronDown className="model-picker-arrow" size={16} aria-hidden="true" />
      </button>
      {moved && !open && <p className="t-meta model-moved" role="status">
        Its configuration changed, so it moved from {modelNameFromId(moved.from)}.
        {!disabled && <> <button type="button" className="link" onClick={moved.onUndo}>Undo</button></>}
      </p>}
      {open && <div className="e2 model-picker-pop" id={listId}>
        <ModelChoices value={value} suggestFor={suggestFor} follows={follows} onPick={(id, follow) => { onChange(id, follow); close() }} />
      </div>}
    </div>
  )
}
