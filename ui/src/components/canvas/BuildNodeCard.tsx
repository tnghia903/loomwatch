import { useStore, type NodeProps } from '@xyflow/react'
import { createElement } from 'react'
import { Bot, Box, Circle, FileText, Folder, Inbox, NotebookText, Puzzle, Wrench } from 'lucide-react'
import { KIND_LABEL } from '../../lib/composer-layout/types'
import { chosenIsFile } from '../../lib/knowledge/chosen'
import { middleTruncate } from '../../lib/format'
import type { OutputNode } from '../../lib/runs/graph'
import type { AgentNode } from '../../lib/library/nodeFromDrop'
import type { AgentConfig, AgentStatus, CapabilityRef } from '../../lib/team-file/types'
import { monogramForSpawnCmd } from '../../lib/harnesses'
import { splitModelSelector } from '../../lib/models'
import { allowedSummary } from '../../lib/team-file/allow'
import { workFolder } from '../../lib/team-file/workFolder'
import { StatusGlyph } from '../ui/glyphs'
import { useCanvasActions } from './CanvasActionsContext'
import { CardPorts } from './CardPorts'
import type { CapabilityNode } from './capabilityNode'
import { roleGlyph } from './roleGlyph'
import { depthForZoom, storyLine } from '../../lib/story/depth'
import { markState } from '../../lib/story/mark'
import { AgentMark } from '../ui/AgentMark'

/** The model and its thinking effort, for the trace depth's facts: "sonnet · high effort". */
function modelLine(agent: Pick<AgentConfig, 'model' | 'thinkingEffort'>): string {
  const { modelId, thinkingEffort } = splitModelSelector(agent.model ?? '')
  const effort = agent.thinkingEffort ?? thinkingEffort
  return `${modelId || 'App default'}${effort ? ` · ${effort} effort` : ''}`
}

/** Everything connected to an agent, by name; a skill or a tool says which it is. */
function givenLine(agent: Pick<AgentConfig, 'capabilities'>): string {
  const named = (capability: CapabilityRef) => (capability.kind === 'knowledge' ? capability.name : `${capability.name} ${capability.kind}`)
  return (agent.capabilities ?? []).map(named).join(', ') || 'Nothing connected'
}

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

const HARNESS_BY_MONOGRAM: Record<string, string> = { Cx: 'Codex', C: 'Claude Code', G: 'Gemini', Oc: 'OpenCode', H: 'Hermes', Ow: 'OpenClaw' }

/**
 * The one agent card, drawn in the Build canvas anatomy: icon, harness kind, name, role.
 *
 * The Run canvas ("Full trace") draws the same card rather than a second one — a run shows the
 * team the operator composed, so it must be recognisably the same object. What a run adds is
 * layered under the identity row: the projected task state and the routes into this
 * agent's evidence and its context packet. Nothing here is ever written back to the team file.
 */
export function BuildAgentCard({ id, data, selected }: NodeProps<AgentNode>) {
  const { editable = true, stepById, inspectHandover, toggleEvidenceFan, dropTargetId } = useCanvasActions()
  const { agent, runtime } = data
  const step = stepById.get(id)
  // Semantic zoom: the extra Story and Trace content exists only at that depth, so nothing hidden
  // is ever announced twice (lib/story/depth.ts).
  const depth = useStore((store) => depthForZoom(store.transform[2]))
  const status: AgentStatus = data.waiting ? 'waiting' : runtime?.status ?? agent.status ?? 'idle'

  // A review stop is a person, not a process: no harness, no model — a question and
  // the way to answer it (docs/TEAM_MEMORY.md "operator as a node").
  if (agent.kind === 'operator' || data.waiting) {
    return (
      <article className={cx('build-node kind-operator', `st-${status}`, selected && 'selected')} aria-label={`${agent.name}, ${data.waiting?.question ?? agent.role}`}>
        {step && <span className="step" aria-hidden="true">{step.step}</span>}
        <div className="build-node-body">
          <div className="build-node-row">
            <span className="build-node-icon mark-holder"><AgentMark id={agent.id} name="You" operator state={data.waiting ? 'waiting' : markState(runtime)} animate={runtime?.watching === true || Boolean(data.waiting)} /></span>
            <div>
              <span className="node-kind">You</span>
              <strong className="node-name">{agent.kind === 'operator' && agent.name !== 'You' ? `You · ${agent.name}` : agent.name}</strong>
              <small title={data.waiting?.question ?? agent.role}>{data.waiting?.question ?? agent.role}</small>
              {depth === 'story' && <p className="depth-story-line">{storyLine(agent, data.waiting ? { status: 'waiting', task: '' } : runtime)}</p>}
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
        <CardPorts connectIn={editable} connectOut={editable} />
      </article>
    )
  }

  const monogram = monogramForSpawnCmd(agent.spawn?.cmd ?? '', agent.spawn?.args)
  const harness = typeof data.harnessLabel === 'string' ? data.harnessLabel : HARNESS_BY_MONOGRAM[monogram] ?? 'Harness'
  const eventCount = runtime?.eventCount ?? 0
  const givenNotes = runtime?.givenNotes ?? 0
  // The job the instructions describe, when they name one; a generic agent keeps the robot.
  const named = roleGlyph(`${agent.name} ${agent.role}`)
  // A folder chosen for it, which nothing connected changes (ADR 0042, lib/team-file/workFolder.ts).
  const folder = workFolder(agent.spawn?.cwd)
  const chosenFolder = folder.kind === 'chosen' ? folder : null
  return (
    <article
      className={cx('build-node kind-harness', runtime && 'has-run', runtime && `st-${status}`, selected && 'selected', dropTargetId === id && 'drop-target')}
      // While a run is shown the node wrapper already carries the run's own accessible name,
      // so labelling the card too would announce the same agent twice.
      aria-label={runtime ? undefined : [agent.name, harness, agent.role, data.appProblem].filter(Boolean).join(', ')}
    >
      {step && <span className="step" aria-hidden="true">{step.step}</span>}
      <div className="build-node-body">
        <div className="build-node-row">
          <span className="build-node-icon mark-holder"><AgentMark id={agent.id} name={agent.name} state={markState(runtime)} events={eventCount} animate={runtime?.watching === true} /><span className="mark-badge" aria-hidden="true">{createElement(named === Circle ? Bot : named, { size: 9 })}</span></span>
          <div><span className="node-kind">{harness}</span><strong className="node-name">{agent.name}</strong><small title={agent.role}>{agent.role || 'Select to set a role'}</small>{depth === 'story' && <p className="depth-story-line">{storyLine(agent, runtime)}</p>}</div>
          {runtime && <StatusGlyph status={status} />}
        </div>
        {/* Before a run, not during one: a run that could not start says so in its own error. */}
        {data.appProblem && !runtime && <p className="build-node-app-problem">{data.appProblem}</p>}
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
            </span>
          </>
        )}
        {/* Trace depth: what the agent panel would tell, without opening it (ADR 0039): its model,
            what it may do without asking, what it is given and a folder chosen for it. The command
            and id stay in Show YAML and the panel's header. Hidden by CSS at the other depths, so
            it is never announced twice. */}
        {depth === 'trace' && <dl className="depth-trace-facts">
          <dt>Model</dt><dd>{modelLine(agent)}</dd>
          <dt>Allowed</dt><dd>{allowedSummary(agent)}</dd>
          <dt>Given</dt><dd>{givenLine(agent)}</dd>
          {chosenFolder && <><dt>Works in</dt><dd title={chosenFolder.path}>{chosenFolder.name}</dd></>}
          {runtime && <><dt>Events</dt><dd>{eventCount}{runtime.openCalls ? ` · ${runtime.openCalls} still open` : ''}</dd></>}
        </dl>}
      </div>
      {data.isEntrypoint && <span className="primary-chip">Start</span>}
      {/* Dragging down from an agent attaches a resource below it (lib/canvas/ports.ts). */}
      <CardPorts connectIn={editable} connectOut={editable} connectDown={editable} />
      {Object.keys(data.fieldProblems ?? {}).length > 0 && <span className="build-node-issue" title={`Check settings for ${id}`}>Check settings</span>}
    </article>
  )
}

export function BuildOutputCard({ data, selected }: NodeProps<OutputNode>) {
  return <article className={`build-node kind-output planned ${selected ? 'selected' : ''}`} aria-label={`Output, No run yet.${data.sendsTo ? ` Also sent to ${data.sendsTo}.` : ''}`}>
    <CardPorts output={false} connectIn={data.configurable === true} />
    <span className="build-node-icon"><FileText size={18} /></span>
    <div><span className="node-kind">Output</span><strong>{data.outputName || 'Team response'}</strong><small>{data.outputFormat || `Produced by ${data.producerLabel}`}</small>
      {data.sendsTo && <small className="build-output-sends">Also sent to {data.sendsTo}</small>}</div>
    <span className="visually-hidden">{data.placeholder}</span>
  </article>
}

export function BuildCapabilityCard({ data, selected }: NodeProps<CapabilityNode>) {
  // A folder or file the operator chose (ADR 0042) says which it is and where it lives; a Notion
  // page (ADR 0050) says it is one, since its address means nothing on a card.
  const file = data.path ? chosenIsFile(data.path) : false
  const Icon = data.notionPage ? NotebookText : data.path ? (file ? FileText : Folder) : data.kind === 'skill' ? Puzzle : data.kind === 'tool' ? Wrench : Box
  const kind = data.notionPage ? 'Notion page' : data.path ? (file ? 'file' : 'folder') : data.kind
  const what = data.notionPage ? 'a Notion page read when each run starts' : data.path ? `${data.source.toLowerCase()} at ${data.path}` : `${KIND_LABEL[data.kind].toLowerCase()} from ${data.source}`
  return <article className={`build-node kind-${data.kind} ${selected ? 'selected' : ''}`} aria-label={`${data.name}, ${what}, ${data.wiredTo ? `used by ${data.wiredTo} agent${data.wiredTo === 1 ? "" : "s"}` : 'not connected to an agent yet'}`}>
    <CardPorts output={false} connectIn={!data.readOnly} />
    <span className="build-node-icon"><Icon size={18} /></span>
    <div><span className="node-kind">{kind}</span><strong>{data.name}</strong><small title={data.path ?? data.source}>{data.notionPage ? 'Read when each run starts' : data.path ? middleTruncate(data.path, 40) : data.source}</small></div>
    {/* Removed from its panel or with Delete, like an agent card: no second remove button here (ADR 0043). */}
  </article>
}
