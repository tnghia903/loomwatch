import { useStore, type NodeProps } from '@xyflow/react'
import { createElement } from 'react'
import { Bot, Box, Circle, FileText, Folder, NotebookText, Puzzle, Wrench } from '../ui/icon'
import { KIND_LABEL } from '../../lib/composer-layout/types'
import { chosenIsFile } from '../../lib/knowledge/chosen'
import { middleTruncate } from '../../lib/format'
import type { OutputNode } from '../../lib/runs/graph'
import type { AgentNode } from '../../lib/library/nodeFromDrop'
import type { AgentConfig, CapabilityRef } from '../../lib/team-file/types'
import { modelLabelForAgent, splitModelSelector } from '../../lib/models'
import { allowedSummary } from '../../lib/team-file/allow'
import { workFolder } from '../../lib/team-file/workFolder'
import { useCanvasActions } from './CanvasActionsContext'
import { CardPorts } from './CardPorts'
import type { CapabilityNode } from './capabilityNode'
import { roleGlyph } from './roleGlyph'
import { depthForZoom, storyLine } from '../../lib/story/depth'
import { effortWord } from '../../lib/ai/efforts'
import { FigureStill } from '../agents/FigureStill'
import { useAgentFigure } from '../agents/figureContext'
import { plainWords } from '../../lib/chat/findWords'
import { AgentMark } from '../ui/AgentMark'
import { InlineMarkdown } from '../ui/Markdown'

/** The model and its thinking effort, for the trace depth's facts: "sonnet · high effort". */
function modelLine(agent: Pick<AgentConfig, 'model' | 'thinkingEffort'>): string {
  const { modelId, thinkingEffort } = splitModelSelector(agent.model ?? '')
  const effort = agent.thinkingEffort ?? thinkingEffort
  return `${modelId || 'Default model'}${effort && effort !== 'default' ? ` · ${effortWord(effort).toLowerCase()} effort` : ''}`
}

/** Everything connected to an agent, by name; a skill or a tool says which it is. */
function givenLine(agent: Pick<AgentConfig, 'capabilities'>): string {
  const named = (capability: CapabilityRef) => (capability.kind === 'knowledge' ? capability.name : `${capability.name} ${capability.kind}`)
  return (agent.capabilities ?? []).map(named).join(', ') || 'Nothing connected'
}

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

/**
 * The one agent card, drawn in the Workflow canvas anatomy: icon, model, name, role. A run is not
 * drawn here: what each agent did is read in the team's chat and its Details.
 */
export function BuildAgentCard({ id, data, selected }: NodeProps<AgentNode>) {
  const { editable = true, stepById, dropTargetId } = useCanvasActions()
  const { agent } = data
  // It wears the figure it wears in Your agents, so the same agent looks the same everywhere.
  const figure = useAgentFigure(agent)
  const step = stepById.get(id)
  // Semantic zoom: the extra Story and Trace content exists only at that depth, so nothing hidden
  // is ever announced twice (lib/story/depth.ts).
  const depth = useStore((store) => depthForZoom(store.transform[2]))

  // A review stop is a person, not a process: no harness, no model — the decision it pauses
  // for (docs/TEAM_MEMORY.md "operator as a node").
  if (agent.kind === 'operator') {
    const status = agent.status ?? 'idle'
    return (
      <article className={cx('build-node kind-operator', `st-${status}`, selected && 'selected')} aria-label={`${agent.name}, ${agent.role}`}>
        {step && <span className="step" aria-hidden="true">{step.step}</span>}
        <div className="build-node-body">
          <div className="build-node-row">
            <span className="build-node-icon mark-holder"><AgentMark id={agent.id} name="You" operator /></span>
            <div>
              <span className="node-kind">You</span>
              <strong className="node-name">{agent.name !== 'You' ? `You · ${agent.name}` : agent.name}</strong>
              <small title={plainWords(agent.role)}><InlineMarkdown clickable={false}>{agent.role}</InlineMarkdown></small>
              {depth === 'story' && <p className="depth-story-line">{storyLine(agent)}</p>}
            </div>
          </div>
          <span className="build-node-task"><span className="task-text">{status === 'succeeded' ? 'Decision received' : 'Pauses for your decision'}</span></span>
          {data.instructionNote && <p className="build-node-instruction-note">{data.instructionNote}</p>}
        </div>
        <CardPorts connectIn={editable} connectOut={editable} />
      </article>
    )
  }

  const model = data.modelLabel ?? modelLabelForAgent(agent)
  // The job the instructions describe, when they name one; a generic agent keeps the robot.
  const named = roleGlyph(`${agent.name} ${agent.role}`)
  // A folder chosen for it, which nothing connected changes (ADR 0042, lib/team-file/workFolder.ts).
  const folder = workFolder(agent.spawn?.cwd)
  const chosenFolder = folder.kind === 'chosen' ? folder : null
  return (
    <article
      className={cx('build-node kind-harness', selected && 'selected', dropTargetId === id && 'drop-target')}
      aria-label={[agent.name, model, plainWords(agent.role), data.instructionNote].filter(Boolean).join(', ')}
    >
      {step && <span className="step" aria-hidden="true">{step.step}</span>}
      <div className="build-node-body">
        <div className="build-node-row">
          <span className="build-node-icon figure-holder"><FigureStill className="build-node-figure" figure={figure} alt="" draggable={false} /><span className="mark-badge" aria-hidden="true">{createElement(named === Circle ? Bot : named, { size: 9 })}</span></span>
          <div><span className="node-kind">{model}</span><strong className="node-name">{agent.name}</strong><small title={plainWords(agent.role)}>{agent.role ? <InlineMarkdown clickable={false}>{agent.role}</InlineMarkdown> : 'Select to set a role'}</small>{depth === 'story' && <p className="depth-story-line">{storyLine(agent)}</p>}</div>
        </div>
        {/* LoomWatch changed these instructions, or could not, after a removal (ADR 0059). */}
        {data.instructionNote && <p className="build-node-instruction-note">{data.instructionNote}</p>}
        {/* Trace depth: what the agent panel would tell, without opening it (ADR 0039): its model,
            what it may do without asking, what it is given and a folder chosen for it. The id stays in
            the panel's header and the command in the team file. Hidden by CSS at the other depths,
            so it is never announced twice. */}
        {depth === 'trace' && <dl className="depth-trace-facts">
          <dt>Model</dt><dd>{modelLine(agent)}</dd>
          <dt>Allowed</dt><dd>{allowedSummary(agent)}</dd>
          <dt>Given</dt><dd>{givenLine(agent)}</dd>
          {chosenFolder && <><dt>Works in</dt><dd title={chosenFolder.path}>{chosenFolder.name}</dd></>}
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
