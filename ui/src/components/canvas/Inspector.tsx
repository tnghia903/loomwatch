import { X } from 'lucide-react'
import { createElement, useState } from 'react'

import type { HarnessModel } from '../../lib/harnesses'
import type { AgentNode } from '../../lib/library/nodeFromDrop'
import { splitModelSelector } from '../../lib/models'
import type { AgentField, AgentFieldProblems } from '../../lib/team-file/validation'
import { StatusGlyph } from '../ui/glyphs'
import { roleGlyph } from './roleGlyph'

export interface InspectorProps {
  node: AgentNode
  isEntrypoint: boolean
  isResponder: boolean
  onRename: (field: 'name' | 'role', value: string) => void
  onModelChange: (value: string) => void
  onThinkingEffortChange?: (value: string) => void
  onCwdChange: (value: string) => void
  onAllowRecruitingChange: (allow: boolean) => void
  /** docs/TEAM_MEMORY.md §5: per-agent `memory.brief` / `memory.deliverAs`. */
  onMemoryBriefChange?: (readsBrief: boolean) => void
  onDeliverAsChange?: (deliverAs: 'native-file' | 'packet-only') => void
  /** How many Brief entries this team supplies, so the zone never promises what does not exist. */
  briefCount?: number
  /** The team-level default a per-agent `deliverAs` narrows. */
  teamDeliverAs?: 'native-file' | 'packet-only'
  onPromoteEntrypoint: () => void
  onPromoteResponder: () => void
  onDelete: () => void
  onClose: () => void
  onFieldBlur: (field: AgentField) => void
  modelOptions?: readonly HarnessModel[]
  defaultThinkingEffort?: string
  modelOptionsLoading?: boolean
  modelOptionsError?: string | null
  /** Why the operator was sent to this agent, when something else opened the panel for them. */
  fixHint?: string
  onDismissFixHint?: () => void
  onRetryModelOptions?: () => void
  fieldProblems?: AgentFieldProblems
  readOnly?: boolean
  pipeline?: boolean
}

// UX_REDESIGN §5.4: three zones in the order the operator thinks — IDENTITY (what stands
// between a drop and a valid save), BEHAVIOUR (what the agent may do), PROCESS (collapsed).
// No Apply button: every edit is immediate in memory; the disk write is ⌘S and only ⌘S.
export function Inspector({ node, isEntrypoint, isResponder, onRename, onModelChange, onThinkingEffortChange, onCwdChange, onAllowRecruitingChange, onMemoryBriefChange, onDeliverAsChange, briefCount = 0, teamDeliverAs = 'native-file', onPromoteEntrypoint, onPromoteResponder, onDelete, onClose, onFieldBlur, modelOptions = [], defaultThinkingEffort, modelOptionsLoading = false, modelOptionsError = null, onRetryModelOptions, fixHint, onDismissFixHint, fieldProblems, readOnly = false, pipeline = false }: InspectorProps) {
  const { agent, runtime } = node.data
  const [processOpen, setProcessOpen] = useState(false)
  const status = runtime?.status ?? agent.status ?? 'idle'
  const parsedSelector = splitModelSelector(agent.model ?? '')
  const selectableModelsById = new Map<string, HarnessModel>(modelOptions.map((model) => [model.id, model]))
  if (parsedSelector.modelId && !selectableModelsById.has(parsedSelector.modelId)) selectableModelsById.set(parsedSelector.modelId, { id: parsedSelector.modelId, name: parsedSelector.modelId, thinkingEfforts: [] })
  const selectableModels = [...selectableModelsById.values()]
  const selectedModel = selectableModels.find((model) => model.id === parsedSelector.modelId)
  const configuredEffort = agent.thinkingEffort ?? parsedSelector.thinkingEffort ?? defaultThinkingEffort
  const thinkingOptions = selectedModel?.thinkingEfforts ?? []
  const selectedEffortIndex = Math.max(0, thinkingOptions.findIndex((effort) => effort.id === configuredEffort))
  const selectedEffort = thinkingOptions[selectedEffortIndex]
  // A team with no Brief supplies nothing, so neither switch may read as "on": that would be a
  // promise about nothing, and both are disabled in that state anyway.
  const readsBrief = agent.memory?.brief !== false && briefCount > 0
  const nativeFile = (agent.memory?.deliverAs ?? teamDeliverAs) === 'native-file' && briefCount > 0
  const zoneClass = (field: AgentField) => fieldProblems?.[field] ? (fieldProblems[field]?.weight === 'error' ? 'error' : 'needs') : ''
  const hint = (field: AgentField, fallback = '') => fieldProblems?.[field]?.message ?? fallback
  // A catalog failure outranks the field problem it causes. Switching harness clears the model,
  // so `model` is always "Required" in exactly the state where the catalog could not be read —
  // showing the field problem there left an empty list, no reason for it, and no way back.
  const modelHint = modelOptionsLoading
    ? 'Loading models from this app…'
    : modelOptionsError
      ? `Could not load this app's models: ${modelOptionsError}`
      : hint('model', 'The models this AI app offers.')

  if (agent.kind === 'operator') return (
    <aside className="panel right top e1 lw-inspector" aria-label="Inspector" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
      <div className="inspector-scroll">
        <div className="zone">
          <button type="button" className="iconbtn" aria-label="Close inspector" onClick={onClose}><X size={16} /></button>
          <h2 className="t-title">You · Review stop</h2>
          <label className="field">Name<input className="input" aria-label="Review stop name" value={agent.name} readOnly={readOnly} onChange={(e) => onRename('name', e.target.value)} onBlur={() => onFieldBlur('name')} /></label>
          <label className="field">Question<textarea className="input" data-agent-field="role" aria-label="Review question" value={agent.role} readOnly={readOnly} onChange={(e) => onRename('role', e.target.value)} onBlur={() => onFieldBlur('role')} /></label>
          <p className="t-meta">The pipeline pauses here for your decision. Your answer becomes direction for the next stage.</p>
          {!readOnly && <button type="button" className="btn btn-danger" onClick={onDelete}>Delete</button>}
        </div>
      </div>
    </aside>
  )

  return (
    <aside className="panel right top e1 lw-inspector" aria-label="Inspector" role="region" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
      <div className="inspector-glass" aria-hidden="true" />
      <div className="inspector-scroll">
      <header className="insp-head">
        <span className="node-glyph">{createElement(roleGlyph(agent.role), { size: 20, 'aria-hidden': 'true' })}</span>
        <span className="insp-text">
          <div className={`insp-title t-title field ${zoneClass('name')}`}>
            <input value={agent.name} aria-label="Name" data-agent-field="name" readOnly={readOnly} onChange={(event) => onRename('name', event.target.value)} onBlur={() => onFieldBlur('name')} />
          </div>
          <div className="insp-id t-mono">{agent.id}</div>
          <div className="insp-status t-micro"><StatusGlyph status={status} /> {runtime ? `${runtime.taskState.toLowerCase()} · ${runtime.task}` : status}{runtime?.busUnavailable ? ' · no Team Bus access' : ''}</div>
        </span>
        <button type="button" className="iconbtn" onClick={onClose} title="Close (Esc)" aria-label="Close inspector"><X size={15} aria-hidden="true" /></button>
      </header>
      {fixHint && (
        <p className="inspector-fix-hint t-meta" role="note">
          <span>{fixHint}</span>
          {onDismissFixHint && <button type="button" className="iconbtn" onClick={onDismissFixHint} aria-label="Dismiss this note"><X size={13} aria-hidden="true" /></button>}
        </p>
      )}

      <div className="zone">
        <div className="zone-head t-micro">Identity</div>
        <div className={`field ${zoneClass('role')}`}>
          <label className="t-meta" htmlFor="insp-role">Role and instructions</label>
          <textarea id="insp-role" className="input" data-agent-field="role" value={agent.role} readOnly={readOnly} placeholder="What this agent should do, which sources to use, what to pass on." onChange={(event) => onRename('role', event.target.value)} onBlur={() => onFieldBlur('role')} />
          <span className="hint t-meta">{hint('role', 'Included in every turn, including delegated work.')}</span>
        </div>
        <div className={`field ${zoneClass('model')}`}>
          <label className="t-meta" htmlFor="insp-model">Model</label>
          <select id="insp-model" className="input model-select" data-agent-field="model" value={parsedSelector.modelId} disabled={readOnly || modelOptionsLoading} onChange={(event) => {
            if (!agent.thinkingEffort && parsedSelector.thinkingEffort) onThinkingEffortChange?.(parsedSelector.thinkingEffort)
            onModelChange(event.target.value)
          }} onBlur={() => onFieldBlur('model')}>
            {!agent.model && <option value="" disabled>Select a model</option>}
            {selectableModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
          </select>
          <span className="hint t-meta">{runtime?.status === 'running' ? 'Used by the AI app for this run.' : selectedModel?.description ?? modelHint}{modelOptionsError && onRetryModelOptions && <> <button type="button" className="link model-retry" onClick={onRetryModelOptions}>Retry</button></>}</span>
        </div>
        <div className="field thinking-field">
          <span className="thinking-label"><label className="t-meta" htmlFor="insp-thinking">Thinking effort</label><output className="t-body-m" htmlFor="insp-thinking">{selectedEffort?.name ?? 'App default'}</output></span>
          <input
            id="insp-thinking"
            className="thinking-slider"
            type="range"
            min={0}
            max={Math.max(0, thinkingOptions.length - 1)}
            step={1}
            value={selectedEffortIndex}
            disabled={readOnly || modelOptionsLoading || !onThinkingEffortChange || thinkingOptions.length === 0}
            aria-label="Thinking effort"
            aria-valuetext={selectedEffort?.name ?? 'App default'}
            onChange={(event) => {
              const effort = thinkingOptions[Number(event.target.value)]
              if (effort) onThinkingEffortChange?.(effort.id)
            }}
          />
          {thinkingOptions.length > 1 && <span className="thinking-scale t-micro"><span>{thinkingOptions[0].name}</span><span>{thinkingOptions[thinkingOptions.length - 1].name}</span></span>}
          <span className="hint t-meta">{selectedEffort?.description ?? (modelOptionsLoading ? 'Loading effort choices…' : thinkingOptions.length === 0 ? 'This AI app does not offer a separate effort setting.' : 'Controls how much reasoning the model uses.')}</span>
        </div>
      </div>

      <div className="zone">
        <div className="zone-head t-micro">Behaviour</div>
        <button type="button" className={`check round ${isEntrypoint ? 'on' : ''}`} disabled={isEntrypoint || readOnly} onClick={onPromoteEntrypoint} aria-pressed={isEntrypoint} title={isEntrypoint ? 'Every team starts somewhere. Pick another agent to move the entry point.' : undefined}>
          <span className="box"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg></span>
          <span className="txt"><b className="t-body">Starts the team</b><span className="t-meta">Receives your request first</span></span>
        </button>
        <button
          type="button"
          className={`check round ${isResponder ? 'on' : ''}`}
          disabled={isResponder || readOnly || (!pipeline && !isEntrypoint)}
          onClick={onPromoteResponder}
          aria-pressed={isResponder}
          title={!pipeline && !isEntrypoint ? 'Create a pipeline to choose a responder other than the entrypoint.' : isResponder ? 'Pick another pipeline agent to move the team output.' : undefined}
        >
          <span className="box"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg></span>
          <span className="txt"><b className="t-body">Produces the team output</b><span className="t-meta">Its answer becomes the team’s final answer</span></span>
        </button>
        <button type="button" className={`check ${agent.allowRecruiting !== false ? 'on' : ''}`} disabled={readOnly} onClick={() => onAllowRecruitingChange(agent.allowRecruiting === false)} aria-pressed={agent.allowRecruiting !== false}>
          <span className="box"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg></span>
          <span className="txt"><b className="t-body">Can ask other agents for help</b><span className="t-meta">{pipeline ? 'Off when steps run in order — it can still ask others questions' : 'Can hand parts of the task to other agents and ask them questions'}</span></span>
        </button>
        {/* docs/TEAM_MEMORY.md §5: the two per-agent memory keys. The copy uses only the four
            sanctioned words — supplied, retrieved, kept, eligible — and never says the agent
            "knows" or "has read" anything. A team with no Brief says so rather than offering a
            switch over nothing. */}
        {onMemoryBriefChange && (
          <button type="button" className={`check ${readsBrief ? 'on' : ''}`} disabled={readOnly || briefCount === 0} onClick={() => onMemoryBriefChange(agent.memory?.brief === false)} aria-pressed={readsBrief}>
            <span className="box"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg></span>
            <span className="txt"><b className="t-body">Reads the team Brief</b><span className="t-meta">{briefCount === 0 ? 'This team has no Brief yet — add one in Memory' : `Supplied ${briefCount} ${briefCount === 1 ? 'entry' : 'entries'} at the start of every session`}</span></span>
          </button>
        )}
        {onDeliverAsChange && (
          <button type="button" className={`check ${nativeFile ? 'on' : ''}`} disabled={readOnly || briefCount === 0} onClick={() => onDeliverAsChange(nativeFile ? 'packet-only' : 'native-file')} aria-pressed={nativeFile}>
            <span className="box"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg></span>
            <span className="txt"><b className="t-body">Brief in its own memory file</b><span className="t-meta">{nativeFile ? "Written into the managed workspace as the harness's own memory file, which a compaction does not reach" : 'Packet only — it keeps its declared folder, and a compaction can summarise the Brief away'}</span></span>
          </button>
        )}
      </div>

      <div className="zone">
        <button type="button" className="zone-head toggle t-micro" onClick={() => setProcessOpen((open) => !open)} aria-expanded={processOpen}>
          <span aria-hidden="true">{processOpen ? '▾' : '▸'}</span> Process
        </button>
        {processOpen && (
          <>
            <dl className="proc-list t-mono-sm">
              <dt>cmd</dt><dd>{agent.spawn?.cmd ?? ''}</dd>
              <dt>args</dt><dd>{agent.spawn?.args?.join(' ') || '—'}</dd>
              <dt>env</dt><dd>{Object.keys(agent.spawn?.env ?? {}).length > 0 ? Object.keys(agent.spawn?.env ?? {}).join(', ') : '—'}</dd>
            </dl>
            <div className={`field ${zoneClass('cwd')}`}>
              <label className="t-meta" htmlFor="insp-cwd">Working folder</label>
              <input id="insp-cwd" className="input mono" data-agent-field="cwd" value={agent.spawn?.cwd ?? '.'} readOnly={readOnly} onChange={(event) => onCwdChange(event.target.value)} onBlur={() => onFieldBlur('cwd')} />
              <span className="hint t-meta">{hint('cwd', 'Relative to the team file')}</span>
            </div>
          </>
        )}
      </div>

      {!readOnly && (
        <footer className="insp-foot">
          <span className="t-meta" style={{ color: 'var(--color-ink-3)' }}>Edits are in memory until ⌘S</span>
          <button type="button" className="btn btn-danger" style={{ border: 0 }} onClick={onDelete}>Delete</button>
        </footer>
      )}
      </div>
    </aside>
  )
}
