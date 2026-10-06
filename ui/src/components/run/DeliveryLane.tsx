import { CapabilityGraph } from './CapabilityGraph'
import { SuppliedInstructions } from './SuppliedInstructions'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  FileText,
  Network,
  Search,
  ShieldCheck,
  Wrench,
  Code2,
  CheckCircle2,
} from 'lucide-react'
import {
  capabilityEvidence,
  type RunCapability,
} from '../../lib/runs/capabilityEvidence'
import { formatOffset } from '../../lib/watch/events'
import type { AllowSwitch } from '../../lib/team-file/types'
import type { RunColumnProps } from './RunColumn'
import { useCanvasActions } from '../canvas/CanvasActionsContext'
import { buildReceipt } from '../../lib/story/receipt'
import { RunReceipt } from './RunReceipt'
import { WeftBar } from './WeftBar'
import type { WeftKnot } from '../../lib/story/weft'
import { markState } from '../../lib/story/mark'
import { AgentMark } from '../ui/AgentMark'

export interface DeliveryLaneProps extends RunColumnProps {
  harnessLabels?: ReadonlyMap<string, string>
  planned?: boolean
  /** Planned runs only: agent id → why its app cannot start on this computer (`lib/team-file/appChecks`). */
  appProblems?: ReadonlyMap<string, string>
  pipeline: boolean
  linearPipeline?: boolean
  onTrace: () => void
  /** ADR 0037: allow what a refused receipt line names, for that agent's next runs. */
  onAllow?: (agentId: string, key: AllowSwitch) => void
  /**
   * A stage to bring into view, raised from outside the lane — today, the operator clicking an
   * Attention alert to reach the agent it belongs to. It is a request, not the selection itself:
   * the lane keeps owning which stage is open, so a later click here still wins.
   */
  focusAgentId?: string | null
  /**
   * The timeline's "Read the message": what the agents said lives in the team's chat beside this
   * lane (ADR 0051), so the lane asks the chat to show the message rather than drawing it again.
   */
  onRevealMessage?: (messageId: string) => void
}

/**
 * How each route is described to the operator, in the daemon's own terms (ADR 0021).
 *
 * `native` deliberately keeps the skill's text out of the prompt, so this must not say "loaded
 * into prompt" for it — that would claim something the run did not do.
 */
const ROUTE_SENTENCE: Record<'native' | 'inline' | 'blocked', string> = {
  native: 'Native — the bundle sits in this harness’s own skill directory and the prompt points at it.',
  inline: 'In-prompt, translated — the harness cannot be relied on to run it as written, so its body was inlined with a mapping note.',
  blocked: 'Blocked — LoomWatch knows no project skill directory for this harness.',
}


/** Run phases as an operator would say them; the raw phase ids are daemon vocabulary. */
const PHASE_WORDS: Partial<Record<string, string>> = {
  queued: 'Queued', starting: 'Starting', running: 'Running', succeeded: 'Finished',
  partial: 'Finished with gaps', failed: 'Failed', cancelled: 'Stopped',
}

/** Run is a reading surface. The saved team canvas remains the editing surface, and detailed
 * evidence still opens the existing inspector rather than maintaining a second raw log viewer. */
export function DeliveryLane({
  prompt,
  attempt,
  phase,
  elapsed,
  mode,
  agents,
  evidenceByAgent,
  output,
  projection,
  pipeline,
  linearPipeline = true,
  planned = false,
  harnessLabels = new Map(),
  appProblems = new Map(),
  onInspectEvidence,
  onSelectAgent,
  onTrace,
  onAllow,
  focusAgentId = null,
  onRevealMessage,
}: DeliveryLaneProps) {
  const [selectedId, setSelectedId] = useState<string | null>(output.producer)
  const [filter, setFilter] = useState<'all' | 'skill' | 'tool'>('all')
  const [query, setQuery] = useState('')
  const [layout, setLayout] = useState<'graph' | 'list'>('graph')
  const [scope, setScope] = useState<'agent' | 'team'>('agent')
  const [receiptSelection, setReceipt] = useState<RunCapability | null>(null)
  const [sourceAgent, setSourceAgent] = useState<string | null>(null)
  const sourceDialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (sourceAgent) sourceDialog.current?.showModal() }, [sourceAgent])
  const receiptBack = useRef<HTMLButtonElement>(null)
  const capabilityButtons = useRef(new Map<string, HTMLButtonElement>())
  const { inspectHandover, toggleProvenance } =
    useCanvasActions()
  const selected =
    agents.find((node) => node.id === selectedId) ??
    agents.find((node) => node.id === output.producer) ??
    agents[0]
  const snapshots = useMemo(
    () =>
      new Map(
        projection.agents.map((agent) => [agent.id, agent.requiredSkills]),
      ),
    [projection.agents],
  )
  // The translation note is archived as its own `skill_translation` prompt section, so the panel
  // shows what was actually sent rather than re-deriving a note the run never used.
  const translationFor = (agentId: string | null, skill: string) =>
    (projection.agents.find((agent) => agent.id === agentId)?.promptSections ?? [])
      .find(
        (section) =>
          section.kind === 'skill_translation' &&
          section.heading.startsWith(`## Reading ${skill} on `),
      )?.text ?? null
  const selfReportFor = (agentId: string | null) =>
    projection.agents.find((agent) => agent.id === agentId)?.skillSelfReport ?? null
  const teamCapabilities = useMemo(
    () =>
      agents.flatMap((node) =>
        capabilityEvidence(
          node.data.agent,
          evidenceByAgent.get(node.id) ?? [],
          snapshots.get(node.id),
        ).map((item) => ({
          ...item,
          id: `${node.id}:${item.id}`,
          agentId: node.id,
          agentName: node.data.agent.name,
        })),
      ),
    [agents, evidenceByAgent, snapshots],
  )
  const capabilities =
    scope === 'team'
      ? teamCapabilities
      : teamCapabilities.filter((item) => item.agentId === selected?.id)
  const receipt =
    capabilities.find((item) => item.id === receiptSelection?.id) ?? null
  const receiptId = receipt?.id
  useEffect(() => {
    if (receiptId) receiptBack.current?.focus()
  }, [receiptId])
  const closeReceipt = () => {
    setReceipt(null)
    requestAnimationFrame(() => {
      if (receiptId) capabilityButtons.current.get(receiptId)?.focus()
    })
  }
  const visible = capabilities.filter(
    (item) =>
      (filter === 'all' || item.kind === filter) &&
      `${item.name} ${item.agentName}`.toLowerCase().includes(query.toLowerCase()),
  )
  const requirements = teamCapabilities.filter((item) => item.required)
  const reads = requirements.filter(
    (item) => item.state === 'read' || item.state === 'loaded',
  ).length
  const select = (id: string) => {
    setSelectedId(id)
    setScope('agent')
    setReceipt(null)
    setQuery('')
  }
  // The loom views of this run: the timeline (who worked when) and, once it ends, the receipt.
  const weftOrder = useMemo(() => agents.map((node) => ({ id: node.id, name: node.data.agent.name, operator: node.data.agent.kind === 'operator', status: node.data.runtime?.status, taskState: node.data.runtime?.taskState })), [agents])
  const terminal = ['succeeded', 'partial', 'failed', 'cancelled'].includes(phase)
  // What passed between the agents, reached from the timeline as well as read under the cards.
  const messageFor = (knot: WeftKnot) => {
    if (knot.evidenceId) return projection.messages.some((message) => message.id === knot.evidenceId) ? knot.evidenceId : null
    // A relay's change of hands is the handover the next stage was given.
    return projection.messages.find((message) => message.kind === 'handover' && message.to === knot.to)?.id ?? null
  }
  const runReceipt = useMemo(() => (planned || !terminal ? null : buildReceipt({
    attempt,
    prompt,
    phase,
    elapsed,
    agents: agents.map((node) => ({ id: node.id, name: node.data.agent.name, operator: node.data.agent.kind === 'operator', runtime: node.data.runtime, allow: node.data.agent.allow })),
    projection,
    evidenceByAgent,
    harnessLabels: new Map(agents.map((node) => [node.id, snapshots.get(node.id)?.[0]?.harness ?? harnessLabels.get(node.id) ?? ''])),
    answered: Boolean(output.text),
  })), [planned, terminal, attempt, prompt, phase, elapsed, agents, projection, evidenceByAgent, snapshots, harnessLabels, output.text])
  // An Attention alert names the agent it belongs to; opening that stage is what "go to it" means
  // on this surface, where the skills and tools panel is already scoped to the selected stage.
  // Adjusted during render rather than in an effect (React's "adjusting state when a prop
  // changes"): a request that arrives with the render is honoured in the same commit, so the lane
  // never paints the previous stage first, and a later click here still wins.
  const [honouredFocus, setHonouredFocus] = useState<string | null>(focusAgentId)
  if (focusAgentId !== honouredFocus) {
    setHonouredFocus(focusAgentId)
    if (focusAgentId) {
      setSelectedId(focusAgentId)
      setScope('agent')
      setReceipt(null)
      setQuery('')
    }
  }
  // Stage motion follows the session, not a recorded status: a replay never shows work in motion.
  const live = mode === 'live' && !planned
  return (
    <main
      className={`delivery-lane ${live ? 'live' : ''}`}
      aria-label="Run workspace"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !receipt) return
        event.stopPropagation()
        closeReceipt()
      }}
    >
      <section className="delivery-work" aria-label="Team work">
        <header className="delivery-heading">
          <div>
            {/* How it went leads; which run it was is a label above it, for the receipt and the trace. */}
            <span className="delivery-eyebrow delivery-run-kicker">{planned ? 'Next run' : `Run ${attempt}`}</span>
            <h1>
              {planned
                ? <>New run<span className="delivery-status status-idle">Not started</span></>
                : <><span className={`delivery-outcome status-${phase}`}>{PHASE_WORDS[phase] ?? phase}</span>{elapsed && <span className="delivery-took">{elapsed}</span>}</>}
            </h1>
            {planned && <p>Describe the result you want to create.</p>}
          </div>
          {/* One control per thing (ADR 0043, 0051): the full trace opens only here. What was asked,
              the answer, and its review live in the chat beside this record, so they are not here. */}
          {!planned && (
            <div className="delivery-heading-acts">
              <button className="btn" onClick={onTrace}><Network size={15} /> Full trace</button>
            </div>
          )}
        </header>
        {runReceipt && <RunReceipt receipt={runReceipt} onInspectEvidence={onInspectEvidence} onAllow={onAllow} />}
        {!planned && projection.startedAt && <WeftBar projection={projection} order={weftOrder} relay={pipeline} onInspectEvidence={onInspectEvidence} messageFor={messageFor} onReadMessage={onRevealMessage} />}
        <div className="delivery-section-head">
          <h2>
            {pipeline && linearPipeline ? 'Team handoff' : 'Team contributions'}
          </h2>
          <span>
            {pipeline && linearPipeline
              ? `${agents.length} stages · 1 deliverable`
              : 'Select an agent to see its work'}
          </span>
        </div>
        <div className="delivery-stages" role="list" aria-label="Team stages" data-tour="stages">
          {agents.map((node, index) => {
            const { agent, runtime } = node.data
            // A planned stage whose app is not on this computer is not ready: the run would fail
            // the moment it reached it. Only a plan says so — a run that happened has its own state.
            const appProblem = planned ? appProblems.get(node.id) : undefined
            const required = capabilityEvidence(
              agent,
              evidenceByAgent.get(node.id) ?? [],
              snapshots.get(node.id),
            ).filter((item) => item.required)
            const working = live && (runtime?.status === 'starting' || runtime?.status === 'running')
            return (
              <div
                className="delivery-stage-wrap"
                role="listitem"
                key={node.id}
              >
                {/* The arrow only shows the order; what an agent received opens from its own card. */}
                {index > 0 && pipeline && linearPipeline && (
                  <span className={`delivery-handoff-arrow prototype-handoff ${working ? 'passing' : ''}`} aria-hidden="true"><span>Handoff</span><ArrowRight size={24} /></span>
                )}
                <article
                  id={`delivery-stage-${node.id}`}
                  className={`delivery-stage ${selected?.id === node.id ? 'selected' : ''} ${working ? 'working' : ''}`}
                  data-tour="stage"
                >
                  <button
                    className="delivery-stage-select"
                    aria-pressed={selected?.id === node.id}
                    onClick={() => select(node.id)}
                  >
                    <span className="delivery-stage-number">{index + 1}</span>
                    <AgentMark id={node.id} name={agent.name} size={22} operator={agent.kind === 'operator'} state={planned ? 'still' : markState(runtime)} events={runtime?.eventCount ?? 0} animate={mode === 'live'} />
                    <span className="delivery-stage-name">
                      <strong>{agent.name}</strong>
                      <small>{agent.role || 'Team agent'}</small>
                    </span>
                    <span
                      className={`delivery-status status-${appProblem ? 'failed' : runtime?.status ?? 'idle'}`}
                    >
                      {appProblem
                        ? 'Can’t start'
                        : planned
                          ? 'Ready'
                          : (runtime?.taskState?.toLowerCase() ?? 'waiting')}
                    </span>
                  </button>
                  {appProblem && <p className="delivery-stage-problem">{appProblem}</p>}
                  <div className="delivery-agent-facts">
                    <div><span>{agent.kind === 'operator' ? 'Done by' : 'AI app'}</span><strong><Code2 size={15} />{agent.kind === 'operator' ? 'You' : snapshots.get(node.id)?.[0]?.harness ?? harnessLabels.get(node.id) ?? 'Not recorded'}</strong></div>
                    <div><span>{planned ? 'Produces' : 'Contribution'}</span><strong>{node.id === output.producer ? 'Team output' : pipeline ? 'Stage handoff' : 'Agent response'}</strong></div>
                    {(evidenceByAgent.get(node.id) ?? []).some(item => item.kind === 'source') && <div><span>Sources</span><button className="delivery-link" onClick={() => setSourceAgent(node.id)}><FileText size={14} />{(evidenceByAgent.get(node.id) ?? []).filter(item => item.kind === 'source').length} sources <ArrowRight size={12} /></button></div>}
                  </div>
                  <div className="delivery-stage-meta">
                    <span>
                      {agent.kind === 'operator'
                        ? 'Your review step'
                        : `${snapshots.get(node.id)?.[0]?.harness ?? harnessLabels.get(node.id) ?? 'AI app not recorded'} · ${projection.agents.find((item) => item.id === node.id)?.model ?? agent.model ?? 'model not recorded'}`}
                    </span>
                    <span>{runtime?.eventCount ?? 0} events</span>
                  </div>
                  {required.length > 0 && (
                    <button
                      className="delivery-skill-summary"
                      onClick={() => {
                        select(node.id)
                        setFilter('skill')
                      }}
                    >
                      <CheckCircle2 size={14} />
                      <span className="delivery-required-name">{required[0].name}</span>
                      {planned
                        ? `${required.length} required ${required.length === 1 ? 'skill' : 'skills'}`
                        : `${required.filter((item) => item.receipt?.state === 'opened').length}/${required.length} opened`}
                    </button>
                  )}
                  {(runtime?.hasPacket || runtime?.received) && (
                    <button
                      className="delivery-link"
                      onClick={() => inspectHandover?.(node.id)}
                    >
                      <FileText size={14} /> What this agent received{' '}
                      <ArrowRight size={13} />
                    </button>
                  )}
                </article>
              </div>
            )
          })}
        </div>
        <section
          className="delivery-capabilities"
          aria-label="Skills and tools"
        >
          <div className="delivery-section-head">
            <div>
              <h2>
                {scope === 'team'
                  ? 'Team'
                  : (selected?.data.agent.name ?? 'Agent')}{' '}
                · skills & tools
              </h2>
              <p>
                {planned
                  ? `Skills connected to ${scope === 'team' ? 'your team' : 'this agent'}.`
                  : 'Required skills alongside observed calls.'}
              </p>
            </div>
            {selected && scope === 'agent' && (
              <button
                className="delivery-link"
                onClick={() => onSelectAgent(selected.id)}
              >
                Agent details
              </button>
            )}
          </div>
          {/* With no required skill there is nothing to count: "0/0 required loaded" only puzzled. */}
          {requirements.length > 0 && <details className="delivery-verification"><summary>{planned ? `${requirements.length} required skills` : `${reads}/${requirements.length} required loaded`}</summary>
            <ShieldCheck size={15} />
            <span>
              {planned
                ? `${requirements.length} required ${requirements.length === 1 ? 'skill' : 'skills'} across the team`
                : requirements.length
                  ? `${reads}/${requirements.length} required skills across the team have loading evidence`
                  : 'No required skills'}
              .{' '}
              {planned
                ? 'Their full instructions are loaded when each agent starts.'
                : agents.every(
                      (node) =>
                        snapshots.has(node.id) &&
                        snapshots.get(node.id) !== undefined,
                    )
                  ? 'Requirements and instruction fingerprints were recorded for this run.'
                  : 'Some requirements are from the open team file; older runs did not archive skill versions.'}
            </span>
          </details>}
          <div className="delivery-filters">
            <div role="group" aria-label="Capability type">
              {(['all', 'skill', 'tool'] as const).map((value) => (
                <button
                  key={value}
                  aria-pressed={filter === value}
                  onClick={() => {
                    setFilter(value)
                    setReceipt(null)
                  }}
                >
                  {value === 'all'
                    ? 'All'
                    : value === 'skill'
                      ? 'Skills'
                      : 'Tools'}
                </button>
              ))}
            </div>
            <select
              className="delivery-scope"
              aria-label="Capability graph scope"
              value={scope}
              onChange={(event) => {
                setScope(event.target.value as 'agent' | 'team')
                setReceipt(null)
              }}
            >
              <option value="agent">Selected agent</option>
              <option value="team">Whole team</option>
            </select>
            <label>
              <Search size={14} />
              <input
                aria-label="Find a skill or tool"
                placeholder="Find capability"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <button
              className="btn"
              aria-label={
                layout === 'graph'
                  ? 'Show capability list'
                  : 'Show capability graph'
              }
              onClick={() => setLayout(layout === 'graph' ? 'list' : 'graph')}
            >
              {layout === 'graph' ? 'List' : 'Graph'}
            </button>
          </div>
          {receipt ? (
            <div className="delivery-receipt">
              <button
                ref={receiptBack}
                className="delivery-link"
                onClick={closeReceipt}
              >
                ← Back to {layout}
              </button>
              <h3>{receipt.name}</h3>
              <p className="delivery-receipt-owner">{receipt.agentName}</p>
              <span className={`delivery-cap-state state-${receipt.state}`}>
                {planned ? 'Required for the next run' : receipt.label}
              </span>
              <p>
                {planned
                  ? 'This connected skill is required. LoomWatch will load its full instructions when this agent starts, then record the source and exact instructions sent.'
                  : receipt.state === 'loaded'
                    ? 'The daemon supplied this skill’s complete instructions in the prompt sent to the agent. Following those instructions and output quality remain separate checks.'
                    : receipt.required && receipt.state === 'failed'
                      ? 'The captured reads of this skill failed. These events do not verify loading. Open a receipt below to inspect the failure.'
                      : receipt.required
                        ? 'A successful recorded read of this skill’s SKILL.md establishes that the instructions were read. It does not establish full instruction coverage or output quality.'
                        : 'These calls were observed for this agent. Their relationship to a skill is not inferred.'}
              </p>
              {receipt.receipt && (
                <dl className="delivery-skill-receipt">
                  <dt>Skill source</dt>
                  <dd>{receipt.receipt.source}</dd>
                  {receipt.receipt.harness && (
                    <>
                      <dt>Run harness</dt>
                      <dd>{receipt.receipt.harness}</dd>
                    </>
                  )}
                  <dt>Instruction file</dt>
                  <dd>{receipt.receipt.path}</dd>
                  <dt>Instructions fingerprint</dt>
                  <dd>{receipt.receipt.sha256}</dd>
                  {receipt.receipt.route && (
                    <>
                      <dt>Route</dt>
                      <dd>
                        {ROUTE_SENTENCE[receipt.receipt.route]}
                        {receipt.receipt.needs?.length
                          ? ` Needs: ${receipt.receipt.needs.join(', ')}.`
                          : ' It assumes nothing this harness lacks.'}
                      </dd>
                    </>
                  )}
                  <dt>Opened by the agent</dt>
                  <dd>
                    {receipt.receipt.state === 'opened'
                      ? 'Yes — its own stream shows it reading the delivered file.'
                      : 'Not recorded. Delivery is not use: nothing in this run’s evidence shows the agent opening it.'}
                  </dd>
                  <dt>Instructions</dt>
                  <dd>
                    {receipt.receipt.chars.toLocaleString()} characters ·{' '}
                    {receipt.receipt.state === 'prepared'
                      ? 'prepared; send not yet recorded'
                      : 'sent in opening prompt'}
                    <SuppliedInstructions receipt={receipt.receipt} />
                  </dd>
                </dl>
              )}
              {translationFor(receipt.agentId, receipt.name) && (
                <div className="delivery-translation">
                  <h4 className="t-body-m">
                    What LoomWatch told this agent about running it here
                  </h4>
                  <pre className="supplied-text t-mono-sm">
                    {translationFor(receipt.agentId, receipt.name)}
                  </pre>
                </div>
              )}
              {selfReportFor(receipt.agentId) && (
                <div className="delivery-translation">
                  <h4 className="t-body-m">
                    What the agent said it could not follow
                  </h4>
                  <p className="t-meta">
                    The agent’s own account. It is not evidence of what happened.
                  </p>
                  <pre className="supplied-text t-mono-sm">
                    {selfReportFor(receipt.agentId)}
                  </pre>
                </div>
              )}
              {receipt.evidence.length ? (
                receipt.evidence.map((item) => (
                  <button
                    className="delivery-receipt-row"
                    key={item.id}
                    onClick={() => onInspectEvidence(item.id)}
                  >
                    <span>
                      #{item.order} · {formatOffset(item.offsetMs)}
                    </span>
                    <strong>{item.name}</strong>
                    <span>
                      {item.status} · {item.capture}
                    </span>
                    <ArrowRight size={15} />
                  </button>
                ))
              ) : receipt.state === 'loaded' || planned ? null : (
                <p className="delivery-no-evidence">
                  No matching read receipt was captured. Local discovery and
                  connected skills alone cannot verify loading.
                </p>
              )}
            </div>
          ) : visible.length ? (
            layout === 'graph' ? <CapabilityGraph items={visible} harnesses={harnessLabels} planned={planned} scoped={scope === 'team'} onInspect={setReceipt} buttonRef={(id, element) => { if (element) capabilityButtons.current.set(id, element); else capabilityButtons.current.delete(id) }} /> : <div className="delivery-cap-groups">
              {agents
                .filter((node) =>
                  visible.some((item) => item.agentId === node.id),
                )
                .map((group) => (
                  <div
                    key={group.id}
                    className={`delivery-cap-map layout-${layout}`}
                    aria-label={`${group.data.agent.name} capability ${layout}`}
                  >
                    {layout === 'list' && scope === 'team' && (
                      <h3 className="delivery-group-name">
                        {group.data.agent.name}
                      </h3>
                    )}
                    <div className="delivery-cap-leaves">
                      {visible
                        .filter((item) => item.agentId === group.id)
                        .map((item) => (
                          <div className="delivery-cap-branch" key={item.id}>
                            <button
                              className={`delivery-cap-leaf state-${item.state}`}
                              aria-label={`Inspect ${item.name}: ${planned && item.required ? 'Will load' : item.label}${scope === 'team' ? ` · ${item.agentName}` : ''}`}
                              ref={(element) => {
                                if (element)
                                  capabilityButtons.current.set(
                                    item.id,
                                    element,
                                  )
                                else capabilityButtons.current.delete(item.id)
                              }}
                              onClick={() => setReceipt(item)}
                            >
                              <span className="delivery-cap-icon">
                                {item.kind === 'skill' ? (
                                  <ShieldCheck size={18} />
                                ) : (
                                  <Wrench size={18} />
                                )}
                              </span>
                              <span>
                                <strong>{item.name}</strong>
                                <small>
                                  {item.required
                                    ? 'Required skill'
                                    : 'Observed tool activity'}
                                </small>
                              </span>
                              <span className="delivery-cap-state">
                                {planned && item.required
                                  ? 'Will load'
                                  : item.label}
                              </span>
                            </button>
                          </div>
                        ))}
                    </div>
                  </div>
                ))}
            </div>
          ) : (
            <p className="delivery-empty">
              {query || filter !== 'all'
                ? 'No capabilities match this filter.'
                : planned ? `No required skills connected to ${scope === 'team' ? 'this team' : 'this agent'}.` : `No required skills or tool activity recorded for ${scope === 'team' ? 'this team' : 'this agent'} yet.`}
            </p>
          )}
          {(requirements.length > 0 || !planned) && <footer className="delivery-cap-footer">
            {requirements.length > 0 && <span>
              Loading evidence and output quality are separate checks.
            </span>}
            {!planned && (
              <button
                className="delivery-link"
                onClick={toggleProvenance}
              >
                What was recorded <ArrowRight size={13} />
              </button>
            )}
          </footer>}
        </section>
      </section>
      {sourceAgent && <dialog ref={sourceDialog} className="delivery-review-dialog" aria-label="Agent sources" onCancel={() => setSourceAgent(null)} onClose={() => setSourceAgent(null)}><h2>{agents.find(node => node.id === sourceAgent)?.data.agent.name}’s sources</h2><p>Sources recorded in this run.</p>{(evidenceByAgent.get(sourceAgent) ?? []).filter(item => item.kind === 'source').map(item => <button key={item.id} className="source-record" onClick={() => { setSourceAgent(null); onInspectEvidence(item.id) }}><FileText size={18} /><span>{item.name}</span><ArrowRight size={14} /></button>)}<div><button className="btn" onClick={() => setSourceAgent(null)}>Close</button></div></dialog>}
    </main>
  )
}
