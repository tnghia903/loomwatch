import { X } from 'lucide-react'
import { createElement, useRef, type ReactNode } from 'react'

import { canonicalModel } from '../../lib/ai/modelIds'
import type { AgentNode } from '../../lib/library/nodeFromDrop'
import { splitModelSelector } from '../../lib/models'
import type { AgentUsage } from '../../lib/team-file/runLessons'
import type { AgentPlace } from '../../lib/team-file/agentPlace'
import type { ModelSuggestionInput } from '../../lib/team-file/modelSuggestion'
import type { AllowSwitch, CapabilityRef, TurnedOff } from '../../lib/team-file/types'
import { holdsTeamFile } from '../../lib/team-file/workFolder'
import type { AgentField, AgentFieldProblems } from '../../lib/team-file/validation'
import { StatusGlyph } from '../ui/glyphs'
import { AgentCheckup, type AgentCheckupProps } from './AgentCheckup'
import { AgentContext } from './AgentContext'
import { AgentPermissions } from './AgentPermissions'
import { AgentSpendGuard } from './AgentSpendGuard'
import { AgentUsageLine } from './AgentUsageLine'
import { CheckStep, type CheckStepProps } from './CheckStep'
import { DoneWhen } from './DoneWhen'
import { InstructionShape } from './InstructionShape'
import { AgentWorkFolder } from './AgentWorkFolder'
import { InstructionsUpdated, type InstructionsUpdatedProps } from './InstructionsUpdated'
import { roleGlyph } from './roleGlyph'
import { EffortSlider } from '../models/EffortSlider'
import { ModelPicker } from '../models/ModelPicker'
import { keys } from '../../lib/platform'

export interface InspectorProps {
  node: AgentNode
  /** Where this agent sits in the team — the panel's mirror of `## Your place in the team`. */
  place?: AgentPlace
  /** Other teams' memory and imported packs supplied to this agent, by display name. */
  inheritedMemory?: readonly string[]
  onRemoveCapability?: (capability: CapabilityRef) => void
  /** The open team file, so an added file can be copied beside it (ADR 0035). */
  teamPath?: string | null
  onAddKnowledge?: (added: CapabilityRef[]) => void
  onRename: (field: 'name' | 'role', value: string) => void
  /** The model picked, and whether it now follows its suggestion (ADR 0072). */
  onModelChange: (value: string, follow: boolean) => void
  /** Its model just moved with its configuration (ADR 0072): from what, and Undo. */
  modelMove?: { from: string; onUndo: () => void }
  /** The agent's own guard on what one run may spend on it, or none with `null` (ADR 0068). */
  onSpendChange?: (perRun: number | null) => void
  /** `undefined` takes the effort out, so the model runs at its own default. */
  onThinkingEffortChange?: (value: string | undefined) => void
  /** Write the agent's Done when list (ADR 0062); absent hides the list. */
  onDoneWhenChange?: (items: string[]) => void
  /** Set on a check step (ADR 0062): whose work it checks, and its send-back switch. */
  checkStep?: Omit<CheckStepProps, 'readOnly'>
  /** This agent and its team: the model its job and place suit is listed first in the model picker. */
  suggestFor?: ModelSuggestionInput
  onCwdChange: (value: string) => void
  onAllowRecruitingChange: (allow: boolean) => void
  /** ADR 0037: one "Allowed without asking" switch. */
  onAllowChange?: (key: AllowSwitch, on: boolean) => void
  /** The team is in Auto mode (ADR 0061): a command this agent's switch leaves open runs when it only reads or downloads. */
  teamAutoMode?: boolean
  /** docs/TEAM_MEMORY.md §5: per-agent `memory.brief` / `memory.deliverAs`. */
  onMemoryBriefChange?: (readsBrief: boolean) => void
  onDeliverAsChange?: (deliverAs: 'native-file' | 'packet-only') => void
  /** How many Brief entries this team supplies, so the zone never promises what does not exist. */
  briefCount?: number
  /** The team-level default a per-agent `deliverAs` narrows. */
  teamDeliverAs?: 'native-file' | 'packet-only'
  onPromoteEntrypoint: () => void
  onDelete: () => void
  onClose: () => void
  onFieldBlur: (field: AgentField) => void
  /** Why the operator was sent to this agent, when something else opened the panel for them. */
  fixHint?: string
  onDismissFixHint?: () => void
  fieldProblems?: AgentFieldProblems
  readOnly?: boolean
  pipeline?: boolean
  /** The team checkup's findings about this agent, with what the panel may do about them. */
  checkup?: Omit<AgentCheckupProps, 'readOnly' | 'headClassName'>
  /** What this agent used in the team's recent runs; absent before any run reported it. */
  usage?: { agent: AgentUsage; runs: number; alone: boolean }
  /** What LoomWatch did to these instructions after a removal (ADR 0059), while it is marked. */
  instructionUpdate?: Omit<InstructionsUpdatedProps, 'agent' | 'readOnly'>
  /** Turn a turned-off skill or tool back on for this agent (ADR 0060). */
  onTurnBackOn?: (entry: TurnedOff) => void
  /** What the agent's app has of its own, and turning one off (ADR 0060). */
  appHas?: { app: string; items: readonly TurnedOff[] } | null
  onTurnOff?: (entry: TurnedOff) => void
  /** Placed from Your agents: the link's panel, shown first. The fields the link copies (name,
      instructions, model and effort, what it may do without asking) are then read-only here. */
  linked?: ReactNode
}

// UX_REDESIGN §5.4: zones in the order the operator thinks — IDENTITY (what stands between a
// drop and a valid save), CONTEXT (what the agent is given; ADR 0034 replaced BEHAVIOUR with
// it), WORKS IN and ALLOWED WITHOUT ASKING (where it works and what it may do there; ADR 0039
// replaced PROCESS, whose command, arguments and environment stay in the team file).
// No Apply button: every edit is immediate in memory; the disk write is ⌘S and only ⌘S.
export function Inspector({ node, place, inheritedMemory = [], onRemoveCapability, teamPath, onAddKnowledge, onRename, onModelChange, modelMove, onSpendChange, onThinkingEffortChange, onDoneWhenChange, checkStep, suggestFor, onCwdChange, onAllowRecruitingChange, onAllowChange, onMemoryBriefChange, onDeliverAsChange, briefCount = 0, teamDeliverAs = 'native-file', onPromoteEntrypoint, onDelete, onClose, onFieldBlur, fixHint, onDismissFixHint, fieldProblems, readOnly = false, pipeline = false, checkup, usage, teamAutoMode = false, instructionUpdate, onTurnBackOn, appHas, onTurnOff, linked }: InspectorProps) {
  // The fields a link to Your agents copies are changed there, or after unlinking.
  const locked = readOnly || Boolean(linked)
  const roleField = useRef<HTMLTextAreaElement>(null)
  const { agent, runtime } = node.data
  const status = runtime?.status ?? agent.status ?? 'idle'
  const nativeFile = (agent.memory?.deliverAs ?? teamDeliverAs) === 'native-file'
  const connected = (agent.capabilities ?? []).length > 0
  const zoneClass = (field: AgentField) => fieldProblems?.[field] ? (fieldProblems[field]?.weight === 'error' ? 'error' : 'needs') : ''
  const hint = (field: AgentField, fallback = '') => fieldProblems?.[field]?.message ?? fallback


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
            <input value={agent.name} aria-label="Name" data-agent-field="name" readOnly={locked} onChange={(event) => onRename('name', event.target.value)} onBlur={() => onFieldBlur('name')} />
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

      {linked && <div className="zone">{linked}</div>}

      <div className="zone">
        <div className="zone-head t-micro">Identity</div>
        <div className={`field ${zoneClass('role')}`}>
          <label className="t-meta" htmlFor="insp-role">Role and instructions</label>
          <textarea ref={roleField} id="insp-role" className={instructionUpdate?.update.state === 'updated' ? 'input instructions-marked' : 'input'} data-agent-field="role" value={agent.role} readOnly={locked} placeholder="What this agent should do, which sources to use, what to pass on." onChange={(event) => onRename('role', event.target.value)} onBlur={() => onFieldBlur('role')} />
          {instructionUpdate && <InstructionsUpdated {...instructionUpdate} agent={agent} readOnly={readOnly} />}
          <InstructionShape role={agent.role} checksDoneWhen={Boolean(agent.doneWhen?.length)} readOnly={locked} field={roleField} onChange={(role) => onRename('role', role)} />
          {onDoneWhenChange && <DoneWhen items={agent.doneWhen ?? []} readOnly={locked} onChange={onDoneWhenChange} />}
          {checkStep && <CheckStep {...checkStep} readOnly={readOnly} />}
          <span className="hint t-meta">{hint('role', 'Included in every turn, including delegated work.')}</span>
        </div>
        {checkup && <AgentCheckup {...checkup} readOnly={readOnly} headClassName="zone-head t-micro" />}
        <div className={`field ${zoneClass('model')}`}>
          <ModelPicker field="model" value={canonicalModel(agent.model)} disabled={locked} suggestFor={suggestFor} follows={linked ? undefined : agent.followsSuggestion === true} moved={modelMove} onChange={(id, follow) => { onModelChange(id, follow); onFieldBlur('model') }} />
          <span className="hint t-meta">{runtime?.status === 'running' ? 'The model this run uses.' : hint('model', 'The model this agent thinks with. Its price is per million tokens, the way OpenRouter shows it.')}</span>
        </div>
        <EffortSlider model={canonicalModel(agent.model)} value={agent.thinkingEffort ?? splitModelSelector(agent.model ?? '').thinkingEffort} disabled={locked} onChange={onThinkingEffortChange} />
        {usage && <AgentUsageLine usage={usage.agent} runs={usage.runs} alone={usage.alone} />}
        {onSpendChange && <AgentSpendGuard perRun={agent.spend?.perRun ?? null} readOnly={locked} onChange={onSpendChange} />}
      </div>

      <div className="zone">
        <AgentContext
          agent={agent} place={place} pipeline={pipeline} briefCount={briefCount} inheritedMemory={inheritedMemory} readOnly={readOnly}
          onPromoteEntrypoint={onPromoteEntrypoint} onAllowRecruitingChange={onAllowRecruitingChange} onMemoryBriefChange={onMemoryBriefChange} onRemoveCapability={onRemoveCapability}
          teamPath={teamPath} onAddKnowledge={onAddKnowledge} onTurnBackOn={onTurnBackOn} appHas={appHas} onTurnOff={onTurnOff} headClassName="zone-head t-micro"
        />
      </div>

      <div className="zone">
        <AgentWorkFolder agent={agent} readOnly={readOnly} onChange={onCwdChange} problem={fieldProblems?.cwd} teamPath={teamPath} headClassName="zone-head t-micro" />
        {/* docs/TEAM_MEMORY.md channel 2: `deliverAs` only decides anything for an agent with a
            Brief and nothing connected, left in the team's folder — a chosen folder is never
            given the memory file (ADR 0042), and otherwise the folder is already settled. */}
        {onDeliverAsChange && briefCount > 0 && !connected && holdsTeamFile(agent) && (
          <button type="button" className={`check ${nativeFile ? '' : 'on'}`} disabled={readOnly} onClick={() => onDeliverAsChange(nativeFile ? 'packet-only' : 'native-file')} aria-pressed={!nativeFile}>
            <span className="box"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg></span>
            <span className="txt"><b className="t-body">Work in this folder</b><span className="t-meta">{nativeFile ? 'Off: it works in its own folder, where the Brief is kept in AGENTS.md for the whole session.' : 'On: it works in the folder above. In a long session the Brief may be summarised away.'}</span></span>
          </button>
        )}
      </div>

      <div className="zone">
        <AgentPermissions agent={agent} readOnly={locked} onChange={onAllowChange} teamAuto={teamAutoMode} headClassName="zone-head t-micro" />
      </div>

      {!readOnly && (
        <footer className="insp-foot">
          <span className="t-meta" style={{ color: 'var(--color-ink-3)' }}>Edits are in memory until {keys('⌘S')}</span>
          <button type="button" className="btn btn-danger" style={{ border: 0 }} onClick={onDelete}>Delete</button>
        </footer>
      )}
      </div>
    </aside>
  )
}
