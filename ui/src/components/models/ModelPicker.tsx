import { Check, ChevronDown, Plug, Sparkles } from '../ui/icon'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { type Catalog, type Model, contextSize, price, shortName } from '../../lib/ai/client'
import { makerOf, sourceMaker } from '../../lib/ai/makers'
import { type ModelSource, type ModelTier, OFFLINE_MODEL, SOURCES, coveringPlan, modelForTier, modelNameFromId, openRouterEquivalent, parseModelRef, tierModel } from '../../lib/ai/modelIds'
import { useSetupReading } from '../../lib/ai/reading'
import { SOURCE_INFO, connectedSources } from '../../lib/ai/sources'
import { useAiStatus } from '../../lib/ai/useKeyStatus'
import { useModels } from '../../lib/ai/useModels'
import { type ModelSuggestionInput, suggestModel } from '../../lib/team-file/modelSuggestion'
import { MakerMark } from './MakerMark'
import { AiChoice } from './AiChoice'

const MAX_RESULTS = 40

/** The models listed for `source`: the plan's and the Claude key's whole lists, OpenRouter's recommended few. */
function listed(catalog: Catalog, source: ModelSource): Model[] {
  if (source === 'chatgpt') return catalog.chatgpt ?? []
  if (source === 'anthropic') return catalog.anthropic ?? []
  return catalog.recommended
}

/** Every model any source lists, to search and to find a model by its id. */
function everyModel(catalog: Catalog): Model[] {
  return [...(catalog.chatgpt ?? []), ...(catalog.anthropic ?? []), ...catalog.models]
}

/** What a row says a model costs: the plan's own words, or its price per million tokens. */
function costOf(model: Model, source: ModelSource): string {
  if (source === 'chatgpt') return 'Included in your plan'
  if (model.free) return 'Free'
  if (unpriced(model, source)) return 'Price not listed'
  return `${price(model.inputPrice)} in · ${price(model.outputPrice)} out`
}

/** A Claude model neither OpenRouter's list nor LoomWatch's own knows the price of: never "Free", since the credit pays for it. */
function unpriced(model: Model, source: ModelSource): boolean {
  return source === 'anthropic' && model.inputPrice === 0 && model.outputPrice === 0
}

/** The source tag on a row and on the picker's button, so how a model is paid is never a guess. */
export function SourceChip({ source }: { source: ModelSource }) {
  return <span className={`model-source-chip ${source}`}>{SOURCE_INFO[source].chip}</span>
}

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
  const source = parseModelRef(model.id).source
  return (
    <button id={id} type="button" {...(plain ? {} : { role: 'option', 'aria-selected': selected })} title={follow} aria-description={follow} className={`pop-row model-row ${selected ? 'current' : ''} ${active ? 'active' : ''}`} onMouseMove={onPoint} onClick={() => onPick(model.id)}>
      <span className="model-row-mark">
        <MakerMark maker={maker} />
        {selected && <span className="model-row-tick" aria-hidden="true"><Check size={10} strokeWidth={3} /></span>}
      </span>
      <span className="name t-body">{shortName(model)}</span>
      <span className="aside t-meta">
        {model.free && source === 'openrouter' ? <span className="badge">Free</span> : costOf(model, source)}
      </span>
      <span className={`t-meta model-row-detail ${why ? 'model-row-why' : ''}`}>
        <SourceChip source={source} />
        {why ?? <>{model.note ? `${model.note} · ` : ''}{maker.name}{model.contextLength ? ` · ${contextSize(model.contextLength)} context` : ''}{source === 'anthropic' ? ' · from your monthly credit' : ''}</>}
      </span>
    </button>
  )
}

/** A source with nothing connected: one row that says what it costs and where to connect it. */
function ConnectRow({ source }: { source: ModelSource }) {
  return (
    <a className="pop-row model-row model-connect-row" href="/connections">
      <span className="model-row-mark"><Plug size={14} aria-hidden="true" /></span>
      <span className="name t-body">Connect {source === 'openrouter' ? 'an OpenRouter key' : source === 'chatgpt' ? 'your ChatGPT plan' : 'your Claude API credit'}</span>
      <span className="t-meta model-row-detail">{SOURCE_INFO[source].cost}</span>
    </a>
  )
}

/**
 * What connecting would change about a suggestion (ruled 2026-10-19): the tier names its model first
 * and a connected plan that offers it pays, else OpenRouter, else a plan's own model stands in.
 * Said when the first choice runs through OpenRouter though its maker's plan could pay for it, or
 * when a plan's own model stands in for a first choice nothing connected can run.
 */
function connectNudge(model: string, tier: ModelTier, source: ModelSource, connected: readonly ModelSource[], offered: (source: ModelSource) => boolean): string | undefined {
  const first = tierModel(tier)
  const plan = coveringPlan(first)
  const missing = plan && offered(plan) && !connected.includes(plan) ? plan : undefined
  const name = modelNameFromId(first)
  const pays = missing === 'anthropic'
    ? { who: 'Claude Max or Team', how: `its monthly API credit can pay for ${name} instead of OpenRouter` }
    : { who: 'ChatGPT Plus or Pro', how: `your plan can run ${name} at no extra charge instead of OpenRouter` }
  if (openRouterEquivalent(parseModelRef(model)) === first) {
    return source === 'openrouter' && missing ? `Have ${pays.who}? Connect it and ${pays.how}.` : undefined
  }
  const ways = missing ? `${missing === 'anthropic' ? 'your Claude API credit' : 'your ChatGPT plan'} or an OpenRouter key` : 'an OpenRouter key'
  return `${name} is the first choice for this work. Connect ${ways} to use it.`
}

/**
 * The model suggested for `suggestFor`'s agent, from what is connected, and from AI's reading of it
 * once one is read. Its reading is asked for only while `active` (the list is open), so the button
 * of a closed list names the same suggestion as the list without asking for one.
 */
function useSuggestion(suggestFor: ModelSuggestionInput | undefined, active: boolean) {
  const ai = useAiStatus()
  // Until the daemon says what is connected, OpenRouter's list shows as it always did.
  const connected: readonly ModelSource[] | null = useMemo(() => (ai ? connectedSources(ai) : null), [ai])
  const read = useSetupReading(suggestFor?.agent, active)
  const suggestion = suggestFor ? suggestModel({ ...suggestFor, reading: read.reading, ...(connected ? { sources: connected } : {}) }) : undefined
  return { ai, connected, read, suggestion }
}

/**
 * The models to choose from, in three clearly separate sections, one per way of paying (ADR 0073):
 * the person's ChatGPT plan, their Claude API credit, and OpenRouter, each headed by what it costs.
 * A source with nothing connected shows one row to connect it instead of its models. Every row says
 * which source it is on. The one suggested for this agent comes first, with why, from all three
 * sources, the plans the person pays for first; "Also good" names the best pick on each other
 * connected source. Search reaches every model of every source. The arrow keys move through the
 * rows and Enter picks, as in the command palette.
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
  const { ai, connected, read, suggestion } = useSuggestion(suggestFor, Boolean(suggestFor))
  const offered = (source: ModelSource) => source !== 'chatgpt' || ai?.chatgpt.available === true
  const [query, setQuery] = useState('')
  const listId = useId()
  const all = useMemo(() => (catalog ? everyModel(catalog) : []), [catalog])
  const found = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length === 0) return []
    return all
      .filter((model) => !connected || connected.includes(parseModelRef(model.id).source))
      .filter((model) => words.every((word) => `${model.id} ${model.name} ${SOURCE_INFO[parseModelRef(model.id).source].chip}`.toLowerCase().includes(word)))
      .slice(0, MAX_RESULTS)
  }, [all, connected, query])
  // Shown only when a list has it: a suggestion is a price and a pick, never a dead row.
  const suggested = suggestion ? all.find((model) => model.id === suggestion.model) : undefined
  const suggestedSource = suggested ? parseModelRef(suggested.id).source : undefined
  // The same kind of model on each other connected source, so the person compares what it costs.
  const alsoGood = suggested && suggestion && connected
    ? connected.filter((source) => source !== suggestedSource).map((source) => all.find((model) => model.id === modelForTier(suggestion.tier, [source]))).filter((model): model is Model => Boolean(model))
    : []
  const nudge = suggestion && suggestedSource && connected ? connectNudge(suggestion.model, suggestion.tier, suggestedSource, connected, offered) : undefined
  const sections = catalog
    ? SOURCES.filter(offered).map((source) => {
        const live = !connected || connected.includes(source)
        const models = live ? listed(catalog, source).filter((model) => model.id !== suggested?.id) : []
        return { source, live: live && (source !== 'chatgpt' || connected !== null), models }
      })
    : []
  const rows = query ? found : [...(suggested ? [suggested] : []), ...sections.flatMap((section) => section.models)]
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
      const row = document.getElementById(optionId(next))
      row?.scrollIntoView?.({ block: 'nearest' })
      // A section's heading stays at the top of the list, so a row scrolled to the top would sit
      // under it: scroll it out from under the heading.
      const head = row?.closest('.model-source-group')?.querySelector('.model-source-head')
      const list = row?.closest('.model-list')
      const covered = head && row ? head.getBoundingClientRect().bottom - row.getBoundingClientRect().top : 0
      if (list && covered > 0) list.scrollTop -= covered
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
  const why = suggestion && suggestedSource ? `${suggestion.why} It runs ${SOURCE_INFO[suggestedSource].on}.` : suggestion?.why
  let index = suggested ? 1 : 0

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
              ? <Row id={`${listId}-suggested-row`} model={suggested} selected={suggested.id === value} active={false} why={why} plain follow={followNote} onPoint={() => {}} onPick={(id) => pick(id, true)} />
              : row(suggested, 0, why)}
          </div>
          {nudge && <p className="t-meta model-connect-nudge">{nudge} <a className="link" href="/connections">Open Connections</a></p>}
          {alsoGood.length > 0 && <p className="t-meta model-also-good">
            Also good: {alsoGood.map((model, place) => {
              const source = parseModelRef(model.id).source
              return <span key={model.id}>{place > 0 && ' · '}<button type="button" className="link" onClick={() => pick(model.id)}>{shortName(model)}</button> {SOURCE_INFO[source].on} ({costOf(model, source).toLowerCase()})</span>
            })}
          </p>}
          {suggestFor && <AiChoice agent={suggestFor.agent} read={read} />}
        </div>}
        <label className="field">
          <span className="t-meta">Search every model</span>
          <input
            className="input" value={query} placeholder="claude, gpt, gemini, plan, free…" autoFocus
            role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
            aria-activedescendant={rows[activeIndex] ? optionId(activeIndex) : undefined}
            onChange={(event) => {
              const next = event.target.value
              setQuery(next)
              setActiveIndex(next.trim() ? 0 : startAt([...(suggested ? [suggested] : []), ...sections.flatMap((section) => section.models)]))
            }}
            onKeyDown={onKeyDown}
          />
        </label>
        <div className="pop-list model-list" role="listbox" id={listId} aria-label={query ? 'Models found' : 'Models by how they are paid'} aria-owns={!query && suggested ? [`${listId}-suggested-group`, ...sections.map((section) => `${listId}-${section.source}`)].join(' ') : undefined}>
          {query ? found.map((model, place) => row(model, place)) : sections.map((section) => (
            <div key={section.source} className={`model-group model-source-group ${section.source}`} role="group" id={`${listId}-${section.source}`} aria-labelledby={`${listId}-${section.source}-head`}>
              <div className="model-source-head">
                <MakerMark maker={sourceMaker(section.source)} />
                <p className="model-source-title t-body-m" id={`${listId}-${section.source}-head`}>{SOURCE_INFO[section.source].heading}</p>
                <p className="t-meta model-source-cost">{SOURCE_INFO[section.source].cost}</p>
              </div>
              {section.live
                ? section.models.map((model) => row(model, index++))
                : <ConnectRow source={section.source} />}
            </div>
          ))}
        </div>
        {query && found.length === 0 && <p className="t-meta lw-settings-quiet">No model matches. Try another word.</p>}
        {!query && <p className="t-meta lw-settings-quiet">Search to reach every OpenRouter model. Free models are limited per day, and their makers may learn from what you send. Keep private work on a paid model.</p>}
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
  // Worked out now, as the list does, so its sources and suggestion are known before it opens, and
  // the button says Suggested whenever the model in use is the one suggested for this agent: on
  // every page, whether or not its model follows the suggestion (that is said in the list).
  const { suggestion } = useSuggestion(suggestFor, open)
  const suggested = Boolean(suggestion && value && value === suggestion.model)
  const source = value && value !== OFFLINE_MODEL ? parseModelRef(value).source : null
  const root = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const labelId = useId()
  const nameId = useId()
  const suggestedId = useId()
  const current = catalog ? everyModel(catalog).find((model) => model.id === value) : undefined

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
      <button ref={toggle} type="button" className="input model-picker-current" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} aria-labelledby={`${labelId} ${nameId}${suggested ? ` ${suggestedId}` : ''}`} data-agent-field={field} disabled={disabled} onClick={() => setOpen(!open)}>
        {value && value !== OFFLINE_MODEL && (value.includes('/') || parseModelRef(value).source !== 'openrouter') && <MakerMark maker={makerOf(value)} />}
        <span className="model-picker-text">
          <span className="t-body" id={nameId}>{current ? shortName(current) : value ? modelNameFromId(value) : 'Choose a model'}</span>
          {source === 'chatgpt' && <span className="t-meta lw-settings-quiet">Using ChatGPT plan · included in your plan</span>}
          {current && source === 'anthropic' && <span className="t-meta lw-settings-quiet">{unpriced(current, source) ? 'Price not listed' : `${price(current.inputPrice)} / ${price(current.outputPrice)} per million tokens`}, from your monthly credit</span>}
          {current && source === 'openrouter' && <span className="t-meta lw-settings-quiet">{current.free ? 'Free' : `${price(current.inputPrice)} / ${price(current.outputPrice)} per million tokens`}</span>}
          {!current && value && value !== OFFLINE_MODEL && catalog && source === 'openrouter' && <span className="t-meta inline-error">Not in OpenRouter’s list</span>}
        </span>
        {source && <SourceChip source={source} />}
        {suggested && <span className="model-picker-suggested t-meta" id={suggestedId}><Sparkles size={11} aria-hidden="true" />Suggested</span>}
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
