import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Bot, Box, FileText, Inbox, Puzzle, Wrench, X } from 'lucide-react'
import { KIND_LABEL } from '../../lib/composer-layout/types'
import { formatUsd, middleTruncate } from '../../lib/format'
import type { OutputNode } from '../../lib/runs/graph'
import type { AgentNode } from '../../lib/library/nodeFromDrop'
import type { AgentStatus } from '../../lib/team-file/types'
import { monogramForSpawnCmd } from '../../lib/harnesses'
import { StatusGlyph } from '../ui/glyphs'
import { useCanvasActions } from './CanvasActionsContext'
import type { CapabilityNode } from './capabilityNode'

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

const HARNESS_BY_MONOGRAM: Record<string, string> = { Cx: 'Codex', C: 'Claude Code', G: 'Gemini', Oc: 'OpenCode', H: 'Hermes', Ow: 'OpenClaw' }

/**
 * The one agent card, drawn in the Build canvas anatomy: icon, harness kind, name, role.
 *
 * The Run canvas ("Full trace") draws the same card rather than a second one — a run shows the
 * team the operator composed, so it must be recognisably the same object. What a run adds is
 * layered under the identity row: the projected task state, the spend, and the routes into this
 * agent's evidence and its context packet. Nothing here is ever written back to the team file.
 */
export function BuildAgentCard({ id, data, selected }: NodeProps<AgentNode>) {
  const { editable = true, stepById, inspectHandover, toggleEvidenceFan } = useCanvasActions()
  const { agent, runtime } = data
  const step = stepById.get(id)
  const status: AgentStatus = data.waiting ? 'waiting' : runtime?.status ?? agent.status ?? 'idle'

  // A review stop is a person, not a process: no harness, no model, no spend — a question and
  // the way to answer it (docs/TEAM_MEMORY.md "operator as a node").
  if (agent.kind === 'operator' || data.waiting) {
    return (
      <article className={cx('build-node kind-operator', `st-${status}`, selected && 'selected')} aria-label={`${agent.name}, ${data.waiting?.question ?? agent.role}`}>
        <Handle type="target" position={Position.Left} isConnectable={editable} />
        {step && <span className="step" aria-hidden="true">{step.step}</span>}
        <div className="build-node-body">
          <div className="build-node-row">
            <span className="build-node-icon"><StatusGlyph status={status} size={18} /></span>
            <div>
              <span className="node-kind">You</span>
              <strong className="node-name">{agent.kind === 'operator' && agent.name !== 'You' ? `You · ${agent.name}` : agent.name}</strong>
              <small title={data.waiting?.question ?? agent.role}>{data.waiting?.question ?? agent.role}</small>
            </div>
          </div>
          {data.waiting ? (
            <>
              <span className="build-node-task"><b>Waiting</b><span className="task-text">since {new Date(data.waiting.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {data.waiting.parkNote}</span></span>
              <button type="button" className="btn btn-primary nodrag build-node-answer" onClick={(event) => { event.stopPropagation(); data.onAnswer?.() }}>Answer</button>
            </>
          ) : (
            <span className="build-node-task"><span className="task-text">{status === 'succeeded' ? 'Decision received' : 'Pauses for your decision'}</span></span>
          )}
        </div>
        <Handle type="source" position={Position.Right} isConnectable={editable} />
      </article>
    )
  }

  const monogram = monogramForSpawnCmd(agent.spawn?.cmd ?? '', agent.spawn?.args)
  const harness = typeof data.harnessLabel === 'string' ? data.harnessLabel : HARNESS_BY_MONOGRAM[monogram] ?? 'Harness'
  const pct = runtime?.spentPct ?? null
  const laneClass = pct !== null && pct >= 100 ? 'over' : pct !== null && pct >= (agent.budget?.warnAtPercent ?? 80) ? 'warn' : ''
  const cost = runtime?.costUsd
  const eventCount = runtime?.eventCount ?? 0
  const givenNotes = runtime?.givenNotes ?? 0
  return (
    <article
      className={cx('build-node kind-harness', runtime && 'has-run', runtime && `st-${status}`, selected && 'selected')}
      // While a run is shown the node wrapper already carries the run's own accessible name,
      // so labelling the card too would announce the same agent twice.
      aria-label={runtime ? undefined : `${agent.name}, ${harness}, ${agent.role}`}
    >
      <Handle type="target" position={Position.Left} isConnectable={editable} />
      {step && <span className="step" aria-hidden="true">{step.step}</span>}
      <div className="build-node-body">
        <div className="build-node-row">
          <span className="build-node-icon"><Bot size={18} /></span>
          <div><span className="node-kind">{harness}</span><strong className="node-name">{agent.name}</strong><small title={agent.role}>{agent.role || 'Select to set a role'}</small></div>
          {runtime && <StatusGlyph status={status} />}
        </div>
        {runtime && (
          <>
            <span className="build-node-task"><b>{runtime.ownerLabel} · {runtime.taskState}</b><span className="task-text">{runtime.task}</span></span>
            {(eventCount > 0 || givenNotes > 0 || runtime.received || runtime.hasPacket) && (
              <span className="build-node-chips">
                {/* Supplied, counted from this agent's own stored packet. Never "knows" or "has read". */}
                {givenNotes > 0 && (
                  <span className="mem-chip" title="Notebook entries in this agent's opening prompt. Supplied is not followed — open “What it was given” for the reason each was selected.">
                    given {givenNotes} note{givenNotes === 1 ? '' : 's'}
                  </span>
                )}
                {/* §15.2.3: evidence folds to a count here and fans for one agent at a time. */}
                {eventCount > 0 && toggleEvidenceFan && (
                  <button
                    type="button"
                    className={cx('nodrag handover-chip', runtime.fanned && 'on')}
                    aria-expanded={runtime.fanned === true}
                    aria-label={`${eventCount} event${eventCount === 1 ? '' : 's'} from ${runtime.ownerLabel}; ${runtime.fanned ? 'fold' : 'fan'} its evidence`}
                    onClick={(event) => { event.stopPropagation(); toggleEvidenceFan(agent.id) }}
                  >
                    {eventCount} event{eventCount === 1 ? '' : 's'}{runtime.openCalls ? ' · open' : ''}
                  </button>
                )}
                {/* The packet inspector opens for any agent the run stored a packet for, not only for
                    a stage that was handed something — the entrypoint has a packet and had no predecessor. */}
                {(runtime.received || runtime.hasPacket) && inspectHandover && (
                  <button
                    type="button"
                    className="nodrag handover-chip"
                    title="Show what this agent was supplied at the start of its session"
                    onClick={(event) => { event.stopPropagation(); inspectHandover(agent.id) }}
                  >
                    <Inbox size={11} aria-hidden="true" />
                    What it was given
                  </button>
                )}
              </span>
            )}
            <span className="build-node-meta">
              <span className="model" dir="ltr">{agent.model ? middleTruncate(agent.model) : '—'}</span>
              <span className="cost">{cost !== null && cost !== undefined ? `${formatUsd(cost)} / ${formatUsd(agent.budget?.limitUsd ?? 0)}` : formatUsd(agent.budget?.limitUsd ?? 0)}</span>
            </span>
            <span className={cx('budget-lane', laneClass)} aria-hidden="true"><i style={{ width: `${Math.min(100, pct ?? 0)}%` }} /></span>
          </>
        )}
      </div>
      {data.isEntrypoint && <span className="primary-chip">Start</span>}
      <Handle type="source" position={Position.Right} isConnectable={editable} />
      <Handle id="resources" type="source" position={Position.Right} isConnectable={editable} style={{ top: '72%' }} />
      {Object.keys(data.fieldProblems ?? {}).length > 0 && <span className="build-node-issue" title={`Check settings for ${id}`}>Check settings</span>}
    </article>
  )
}

export function BuildOutputCard({ data, selected }: NodeProps<OutputNode>) {
  return <article className={`build-node kind-output planned ${selected ? 'selected' : ''}`} aria-label="Output, No run yet.">
    <Handle type="target" position={Position.Left} isConnectable={data.configurable === true} />
    <span className="build-node-icon"><FileText size={18} /></span>
    <div><span className="node-kind">Output</span><strong>{data.outputName || 'Team response'}</strong><small>{data.outputFormat || `Produced by ${data.producerLabel}`}</small></div>
    <span className="visually-hidden">{data.placeholder}</span>
  </article>
}

export function BuildCapabilityCard({ data, selected }: NodeProps<CapabilityNode>) {
  const Icon = data.kind === 'skill' ? Puzzle : data.kind === 'tool' ? Wrench : Box
  return <article className={`build-node kind-${data.kind} ${selected ? 'selected' : ''}`} aria-label={`${data.name}, ${KIND_LABEL[data.kind].toLowerCase()} from ${data.source}, ${data.wiredTo ? `used by ${data.wiredTo} agent${data.wiredTo === 1 ? "" : "s"}` : 'not connected to an agent yet'}`}>
    <Handle type="target" position={Position.Left} isConnectable={!data.readOnly} />
    <span className="build-node-icon"><Icon size={18} /></span>
    <div><span className="node-kind">{data.kind}</span><strong>{data.name}</strong><small title={data.source}>{data.source}</small></div>
    {!data.readOnly && <button type="button" className="build-resource-remove nodrag" onClick={(event) => { event.stopPropagation(); data.onRemove?.() }} aria-label={`Remove ${data.name} from the canvas`}><X size={12} /></button>}
  </article>
}
