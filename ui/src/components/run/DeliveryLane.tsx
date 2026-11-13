import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight } from '../ui/icon'
import { capabilityEvidence, hadSkill } from '../../lib/runs/capabilityEvidence'
import type { Evidence, RunEvent, RunPhase, RunProjection } from '../../lib/watch/events'
import { cardActivity, linkedIn, asUse, USE_NAMES, WEB_KINDS, type Use, type UseKind } from '../../lib/watch/cardActivity'
import { useNow } from '../../lib/useNow'
import type { AllowSwitch } from '../../lib/team-file/types'
import { SkillList, UseList, WebList, type FigureGlow, type SkillSummary } from './StageActivity'
import { CardLinkButton, TeamBenches, type BenchStage } from './TeamBenches'
import { converse, type Party } from '../../lib/story/conversation'
import { inTalks, talksAt } from '../../lib/watch/talk'
import { helpersOf } from '../../lib/chat/helpers'
import { workPhase } from '../../lib/watch/workPhase'
import type { FigureMood } from '../../lib/library/figure'
import { listNames } from '../../lib/format'
import type { MessageKind } from '../../lib/watch/messages'
import type { AgentNode } from '../../lib/library/nodeFromDrop'
import { buildReceipt } from '../../lib/story/receipt'
import { RunReceipt } from './RunReceipt'
import { WeftBar } from './WeftBar'
import type { WeftKnot } from '../../lib/story/weft'
import { markLabel, markState } from '../../lib/story/mark'
import type { RunRecord } from '../../lib/runs/client'
import { modelLabelForAgent } from '../../lib/models'
import { useRunQuests } from './useRunQuests'
import { stateLabel } from '../../lib/state/words'

export interface DeliveryLaneProps {
  prompt: string
  attempt: number
  phase: RunPhase
  elapsed: string
  mode: 'live' | 'replay'
  agents: AgentNode[]
  evidenceByAgent: ReadonlyMap<string, Evidence[]>
  /** The team's answer so far, and the agent that wrote it. */
  output: { text: string; producer: string | null }
  projection: RunProjection
  onInspectEvidence: (id: string) => void
  /** The selected stage's "Agent details": its agent's settings. Absent where they are already on
      the page (an agent's own Details, over its bench), so it isn't offered there. */
  onSelectAgent?: (id: string) => void
  /** "What was recorded": every record behind the run, for an expert. */
  onShowRecorded?: () => void
  /** "What it received": the handover an agent was given and the memory packet it was supplied.
      `from` names who handed it over, as the record says, where the run view knows. */
  onShowReceived?: (agentId: string, from?: string) => void
  /** The model each agent runs on, in words, by agent id. */
  harnessLabels?: ReadonlyMap<string, string>
  planned?: boolean
  pipeline: boolean
  linearPipeline?: boolean
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
  /** The run's record, for the quests a finished run earned (lib/quests). */
  record?: RunRecord | null
  /** The run's events up to the replay cursor, for what each figure acts out while it works. */
  events?: readonly RunEvent[]
}

/** The glow a stage's figure wears for its state. Waiting on you is gold, not work. */
function glowOf(status: string | undefined, waiting: boolean): FigureGlow {
  if (waiting) return 'waiting'
  if (status === 'running' || status === 'starting') return 'working'
  if (status === 'succeeded') return 'done'
  if (status === 'failed') return 'failed'
  return null
}

const NO_EVENTS: readonly RunEvent[] = []

/** What a stage's figure acts out at its bench. A replay never shows work in motion. */
function moodOf(status: string | undefined, { live, waiting, working, planned }: { live: boolean; waiting: boolean; working: boolean; planned: boolean }): FigureMood {
  if (planned || !status) return 'still'
  if (waiting) return 'asking'
  switch (status) {
    case 'starting': return live ? 'starting' : 'still'
    case 'running': return working ? 'working' : live ? 'quiet' : 'still'
    case 'waiting': return 'asking'
    case 'succeeded': return 'done'
    case 'failed':
    case 'unavailable': return 'failed'
    case 'stopped': return 'stopped'
    default: return 'still'
  }
}

/** The messages that hand a stage its work: the line under its name says who from. */
const HANDS_WORK: ReadonlySet<MessageKind> = new Set(['handover', 'handoff', 'dispatch'])
/** How long a helper that finished stays at its lead's bench, handing its part back, before it goes. */
const HELPER_LINGER_MS = 3500


const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/** Run phases as an operator would say them; the raw phase ids are daemon vocabulary. */
const PHASE_WORDS: Partial<Record<string, string>> = {
  queued: 'Queued', starting: 'Starting', running: 'Running', succeeded: 'Finished',
  partial: 'Finished with gaps', failed: stateLabel('failed'), cancelled: stateLabel('stopped'),
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
  onInspectEvidence,
  onSelectAgent,
  onShowRecorded,
  onShowReceived,
  onAllow,
  focusAgentId = null,
  onRevealMessage,
  record = null,
  events = NO_EVENTS,
}: DeliveryLaneProps) {
  const [selectedId, setSelectedId] = useState<string | null>(focusAgentId ?? output.producer)
  // The one list open from a stage's tray, and the skill whose receipt is open in it.
  const [openMark, setOpenMark] = useState<{ agentId: string; kind: UseKind } | null>(null)
  const [openSkill, setOpenSkill] = useState<string | null>(null)
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
  // Every agent's requirements and instruction fingerprints were archived with this run.
  const fingerprinted = agents.every((node) => snapshots.has(node.id) && snapshots.get(node.id) !== undefined)
  // Each stage's skills: what it was required to use and what it opened, and what the run shows of each.
  const skillsByAgent = useMemo(() => new Map(agents.map((node): [string, SkillSummary] => {
    const skills = capabilityEvidence(node.data.agent, evidenceByAgent.get(node.id) ?? [], snapshots.get(node.id)).filter((item) => item.kind === 'skill')
    const required = skills.filter((item) => item.required)
    return [node.id, {
      skills,
      required: required.length,
      met: required.filter(hadSkill).length,
    }]
  })), [agents, evidenceByAgent, snapshots])
  const select = (id: string) => setSelectedId(id)
  const openFrom = (agentId: string, kind: UseKind | null) => {
    setOpenMark(kind ? { agentId, kind } : null)
    setOpenSkill(null)
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
    // The model each agent ran on: what the run recorded, else what the team file names now.
    harnessLabels: new Map(agents.map((node) => {
      const recorded = projection.agents.find((item) => item.id === node.id)?.model
      return [node.id, recorded ? modelLabelForAgent({ ...node.data.agent, model: recorded }) : harnessLabels.get(node.id) ?? modelLabelForAgent(node.data.agent)]
    })),
    answered: Boolean(output.text),
    spend: record?.spend,
  })), [planned, terminal, attempt, prompt, phase, elapsed, agents, projection, evidenceByAgent, harnessLabels, output.text, record?.spend])
  // What the run earned on a quest, judged from the whole team file as the run ran it, not from
  // the agents shown or the editor's copy (useRunQuests.ts `agentsRunWith`).
  const earned = useRunQuests({ record: planned ? null : record, projection, phase })
  // An Attention alert names the agent it belongs to; opening that stage is what "go to it" means
  // on this surface, where the skills and tools panel is already scoped to the selected stage.
  // Adjusted during render rather than in an effect (React's "adjusting state when a prop
  // changes"): a request that arrives with the render is honoured in the same commit, so the lane
  // never paints the previous stage first, and a later click here still wins.
  const [honouredFocus, setHonouredFocus] = useState<string | null>(focusAgentId)
  if (focusAgentId !== honouredFocus) {
    setHonouredFocus(focusAgentId)
    if (focusAgentId) setSelectedId(focusAgentId)
  }
  // …and brought into view, since its card can be below the receipt and the timeline.
  useEffect(() => {
    if (honouredFocus) document.getElementById(`delivery-stage-${honouredFocus}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [honouredFocus])
  // Stage motion follows the session, not a recorded status: a replay never shows work in motion.
  const live = mode === 'live' && !planned
  // While the run is watched, what each figure acts out moves with the clock between events too.
  const now = useNow(live)
  // The pages the team's answer links, so the web list can mark the ones it rests on.
  const linked = useMemo(() => linkedIn(output.text ?? ''), [output.text])
  // The stage whose tray list is open under the row.
  const openStage = openMark ? agents.find((node) => node.id === openMark.agentId) ?? null : null
  // The team as the team's chat reads it (lib/story/conversation.ts): who handed each stage its work,
  // and who is talking to whom now, which the spotlight lights while the run is watched.
  const parties = useMemo<Party[]>(() => agents.map((node) => ({ id: node.id, name: node.data.agent.name, operator: node.data.agent.kind === 'operator' })), [agents])
  const lines = useMemo(() => converse(projection.messages, parties).lines, [projection.messages, parties])
  // Only while it runs: once it's over, nobody is talking any more, whatever was left unanswered.
  // One talk at a time, the newest: two cards side by side were too cramped to read in the pane,
  // and a stage lit by a talk no card explains read as a mistake.
  const talks = useMemo(() => (live && !terminal ? talksAt(projection.messages, parties, now).slice(-1) : []), [live, terminal, projection.messages, parties, now])
  const lit = useMemo(() => inTalks(talks), [talks])
  const helpers = useMemo(() => (live ? helpersOf(events) : []), [live, events])
  // The review step is you: "Work from you", not "Work from You".
  const nameOf = (id: string) => { const party = parties.find((each) => each.id === id); return party?.operator ? 'you' : party?.name ?? id }
  // Who handed a stage its work, newest first; the first stage's is the request, from you or from
  // the agent that asked for it for you (ADR 0083, decision 10).
  const handedTo = (id: string, index: number): BenchStage['handed'] => {
    const line = [...lines].reverse().find((item) => item.receiver === id && HANDS_WORK.has(item.message.kind) && item.senders.length > 0)
    if (line) return { from: listNames(line.senders.map(nameOf)) }
    if (index > 0 || !prompt.trim()) return null
    const askedBy = record?.askedBy?.name
    return { from: askedBy ?? 'you', title: askedBy ? `${askedBy} asked this for you. You pressed Start.` : undefined }
  }
  // Beside the record, the receipt stays in view while the record scrolls past it. A slip taller
  // than the pane sticks by its foot rather than its head, so its last lines are never held out of view.
  const work = useRef<HTMLElement>(null)
  const hasReceipt = runReceipt !== null
  useEffect(() => {
    const scroller = work.current
    const slip = scroller?.querySelector<HTMLElement>('.run-receipt')
    if (!scroller || !slip || typeof ResizeObserver === 'undefined') return
    const place = () => scroller.style.setProperty('--receipt-top', `${Math.min(16, scroller.clientHeight - slip.offsetHeight - 16)}px`)
    const size = new ResizeObserver(place)
    size.observe(scroller)
    size.observe(slip)
    return () => size.disconnect()
  }, [hasReceipt])
  return (
    <main
      className={`delivery-lane ${live ? 'live' : ''}`}
      aria-label="Run workspace"
      onKeyDown={(event) => {
        // Escape folds an open tray list away, and gives focus back to the mark that opened it.
        if (event.key !== 'Escape' || !openMark) return
        event.stopPropagation()
        const { agentId, kind } = openMark
        openFrom(agentId, null)
        requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`#delivery-stage-${CSS.escape(agentId)} .stage-mark[data-kind="${kind}"]`)?.focus())
      }}
    >
      <section ref={work} className="delivery-work" aria-label="Team work">
        {/* How it went leads; which run it was is a label above it. Once the run is over, its
            receipt says both, stamped on the slip, so no heading says them again. What was asked,
            the answer, and its review live in the chat beside this record (ADR 0051). */}
        {!runReceipt && (
          <header className="delivery-heading">
            <div>
              <span className="delivery-eyebrow delivery-run-kicker">{planned ? 'Next run' : `Run ${attempt}`}</span>
              <h1>
                {planned
                  ? <>New run<span className="delivery-status status-idle">Not started</span></>
                  : <><span className={`delivery-outcome status-${phase}`}>{PHASE_WORDS[phase] ?? phase}</span>{elapsed && <span className="delivery-took">{elapsed}</span>}</>}
              </h1>
              {planned && <p>Describe the result you want to create.</p>}
            </div>
          </header>
        )}
        {/* A finished run's receipt sits beside the record it sums up, once the pane is wide enough
            for both (delivery.css); a narrower pane keeps it above. */}
        <div className={`delivery-sheet${runReceipt ? ' with-receipt' : ''}`}>
          {runReceipt && <RunReceipt receipt={runReceipt} onInspectEvidence={onInspectEvidence} onAllow={onAllow} earned={earned} />}
          <div className="delivery-record">
            {!planned && projection.startedAt && <WeftBar projection={projection} order={weftOrder} relay={pipeline} onInspectEvidence={onInspectEvidence} messageFor={messageFor} onReadMessage={onRevealMessage} />}
            <div className="delivery-section-head">
              <h2>
                {pipeline && linearPipeline ? 'Team handoff' : 'Team contributions'}
              </h2>
              <span>
                {pipeline && linearPipeline
                  ? `${plural(agents.length, 'stage')} · 1 deliverable`
                  : 'Select an agent to see its work'}
              </span>
              {/* Every record behind the cards, for an expert. */}
              {!planned && onShowRecorded && <button className="delivery-link" onClick={onShowRecorded}>What was recorded <ArrowRight size={13} /></button>}
            </div>
            <TeamBenches
              live={live}
              talks={talks}
              planned={planned}
              finished={terminal}
              animate={mode === 'live'}
              onSelect={select}
              onOpen={openFrom}
              onReadMessage={onRevealMessage}
              stages={agents.map((node, index): BenchStage => {
                const { agent, runtime } = node.data
                // The model the run recorded for it, else the one the team file names now.
                const recorded = projection.agents.find((item) => item.id === node.id)?.model
                const model = agent.kind === 'operator' ? 'Your review step' : recorded ? modelLabelForAgent({ ...agent, model: recorded }) : harnessLabels.get(node.id) ?? modelLabelForAgent(agent)
                // Waiting on you (a permission it asked for) looks like waiting, not work: gold, still.
                const waiting = live && runtime?.status === 'running' && markState(runtime) === 'waiting'
                const working = live && (runtime?.status === 'starting' || runtime?.status === 'running') && !waiting
                const evidence = evidenceByAgent.get(node.id) ?? []
                const activity = cardActivity({ events, evidence, agentId: node.id, working, now, linked })
                const started = Boolean(runtime) && runtime?.status !== 'idle'
                const handed = planned ? null : handedTo(node.id, index)
                const before = index > 0 ? agents[index - 1].data.agent : null
                return {
                  id: node.id,
                  name: agent.name,
                  model,
                  agent,
                  status: planned ? 'Ready' : runtime ? markLabel(markState(runtime), runtime.openCalls) : 'Not started yet',
                  statusClass: `status-${waiting ? 'waiting' : runtime?.status ?? 'idle'}`,
                  glow: planned || agent.kind === 'operator' ? null : glowOf(runtime?.status, waiting),
                  mood: moodOf(runtime?.status, { live, waiting, working, planned }),
                  phase: activity.phase,
                  markState: planned ? 'still' : markState(runtime),
                  events: runtime?.eventCount ?? 0,
                  operator: agent.kind === 'operator',
                  working,
                  selected: selected?.id === node.id,
                  // Someone is talking: those in it stay lit, and so does anyone at work.
                  dim: talks.length > 0 && !lit.has(node.id) && !working,
                  activity,
                  // Its helpers (ADR 0079) at its own bench; one that finished stays a moment, then goes.
                  helpers: helpers
                    .filter((helper) => helper.lead === node.id && (helper.state === 'working' || now - Date.parse(helper.finishedAt ?? '') < HELPER_LINGER_MS))
                    .map((helper) => ({ id: helper.id, state: helper.state === 'stopped' ? 'failed' as const : helper.state, phase: helper.state === 'working' ? workPhase(events, helper.id, now) : null })),
                  skills: skillsByAgent.get(node.id) ?? { skills: [], required: 0, met: 0 },
                  open: openMark?.agentId === node.id ? openMark.kind : null,
                  handed,
                  // What it waits for, while it can still start: once the run is over, it never will.
                  waits: !terminal && pipeline && linearPipeline && before && !started ? `Starts after ${before.kind === 'operator' ? 'your review' : before.name}` : null,
                  // What it was handed opens from the line that says who from: one way to it (ADR 0043).
                  onReceived: (runtime?.hasPacket || runtime?.received) && onShowReceived ? () => onShowReceived(node.id, handed?.from) : undefined,
                  // The selected stage's way to its agent's settings: one on the screen, as before.
                  extra: selected?.id === node.id && agent.kind !== 'operator' && onSelectAgent ? <CardLinkButton onClick={() => onSelectAgent(node.id)}>Agent details</CardLinkButton> : null,
                }
              })}
            />
            {openStage && openMark && (() => {
              const { kind } = openMark
              const evidence = evidenceByAgent.get(openStage.id) ?? []
              const skills = skillsByAgent.get(openStage.id) ?? { skills: [], required: 0, met: 0 }
              const uses = !WEB_KINDS.has(kind) ? evidence.map(asUse).filter((use): use is Use => use?.kind === kind) : []
              const web = cardActivity({ events, evidence, agentId: openStage.id, working: false, now, linked }).web
              return (
                <div className="stage-sheet flow-sheet" role="region" aria-label={`${openStage.data.agent.name}: ${kind === 'skill' ? 'skills' : WEB_KINDS.has(kind) ? 'on the web' : USE_NAMES[kind].toLowerCase()}`}>
                  <p className="flow-sheet-who">{openStage.data.agent.name}</p>
                  {kind === 'skill'
                    ? <SkillList skills={skills} planned={planned} open={openSkill} onOpen={setOpenSkill} translationFor={(skill) => translationFor(openStage.id, skill)} selfReport={selfReportFor(openStage.id)} recorded={fingerprinted} uses={uses} evidence={evidence} onInspect={onInspectEvidence} />
                    : WEB_KINDS.has(kind)
                      ? <WebList web={web} />
                      : <section><h4>{USE_NAMES[kind]} <span>{uses.length}</span></h4><UseList uses={uses} evidence={evidence} onInspect={onInspectEvidence} /></section>}
                </div>
              )
            })()}
          </div>
        </div>
      </section>
    </main>
  )
}
