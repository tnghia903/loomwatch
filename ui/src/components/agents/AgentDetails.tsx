import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'

import { guestsOf } from '../../lib/chat/guests'
import { alwaysAllowGuest } from '../../lib/library/bringIn'
import { agentFromDraft, chatAgentId, type AgentDraft } from '../../lib/library/draft'
import type { FigureChoice } from '../../lib/library/figures'
import { useSavedJobs } from '../../lib/library/jobs'
import { fetchRunContext, type ContextPacket } from '../../lib/memory/client'
import { modelLabelForAgent } from '../../lib/models'
import { fetchRuns, isTerminalRun, type RunRecord } from '../../lib/runs/client'
import { ownerLabelFor } from '../../lib/runs/graph'
import { mergeHistory, teamRunIds } from '../../lib/runs/history'
import { causalOrder } from '../../lib/runs/runOverlay'
import type { DetailsAsked } from '../../lib/runs/useBenchDetails'
import { useRunSession } from '../../lib/runs/useRunSession'
import type { AllowSwitch } from '../../lib/team-file/types'
import { useNow } from '../../lib/useNow'
import { formatElapsed, recordedReplyText } from '../../lib/watch/events'
import { ActivityPanel } from '../run/ActivityPanel'
import { DeliveryLane } from '../run/DeliveryLane'
import { HandoverPanel } from '../run/HandoverPanel'
import { ProvenancePanel } from '../run/ProvenancePanel'
import { runAgentNodes, type RunAgentsInput } from '../workspace/runAgents'
import { GuestNamesContext, TeamFiguresContext } from './figureContext'

export interface AgentDetailsProps {
  asked: DetailsAsked
  /** The agent as it is on screen, as its chat runs it. */
  draft: AgentDraft
  model: string
  chatId: string
  figure: FigureChoice
  onClose: () => void
  /** "Allow from now on" on a line the receipt says was refused: switch it on for this agent. */
  onAllow: (key: AllowSwitch) => void
  /** The timeline's "Read the message": the chat beside it shows the message in its piece. */
  onRevealMessage: (runId: string, id: string) => void
}

const NO_POINTS = {}
const NO_CARDS: [] = []

/**
 * A piece of work's Details in an agent's own chat (ADR 0051's Details, as the team chat shows it
 * beside the chat): the receipt, the timeline and the agent's work, and the record a line or a
 * finding points at, open beside them. An agent's page has its chat where a team's Details goes, so
 * Details opens over the bench, where its long answers and files do (ADR 0077), and you stay with
 * the agent you are working with.
 */
export function AgentDetails({ asked, draft, model, chatId, figure, onClose, onAllow, onRevealMessage }: AgentDetailsProps) {
  const agentId = chatAgentId(chatId)
  const name = draft.name.trim() || 'New agent'
  const session = useRunSession(asked.runId, agentId)
  const { record, projection } = session

  // The agent as its chat runs it, and the person's other agents a run may bring in (ADR 0092).
  const agent = useMemo(() => ({ ...agentFromDraft(draft, model), id: agentId }), [draft, model, agentId])
  const saved = useSavedJobs()
  const guests = useMemo(() => guestsOf(saved.jobs.filter((job) => job.id !== chatId), [name]), [saved.jobs, chatId, name])
  const figures = useMemo(() => new Map([...guests.figures, [agentId, figure] as const]), [guests, agentId, figure])
  const names = useMemo(() => new Map([...guests.names, [agentId, name] as const]), [guests, agentId, name])

  // The record and the panels opened from it: one record at a time, as in a team's Details.
  const [inspected, setInspected] = useState<string | null>(asked.evidenceId ?? null)
  const [recorded, setRecorded] = useState(false)
  const [received, setReceived] = useState<string | null>(null)
  // Opened from the chat, the way back has the focus, so it is in view where the chat is below the
  // bench; a record a finding asked for takes it instead.
  const back = useRef<HTMLButtonElement>(null)
  const toRecord = Boolean(asked.evidenceId)
  useEffect(() => { if (!toRecord) back.current?.focus() }, [toRecord])

  // Which run of this chat it is, as a team's runs are counted, and what each agent was supplied.
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [packets, setPackets] = useState<ContextPacket[] | null>(null)
  const runId = asked.runId
  useEffect(() => {
    let cancelled = false
    fetchRuns().then((all) => { if (!cancelled) setRuns(all) }, () => {})
    fetchRunContext(runId).then((all) => { if (!cancelled) setPackets(all) }, () => { if (!cancelled) setPackets([]) })
    return () => { cancelled = true }
  }, [runId])

  const responderId = record?.responder ?? agentId
  const leadId = record?.onlyAgent ?? record?.startAt ?? record?.entrypoint ?? projection.promptAgentId ?? agentId
  const orderedAgentIds = useMemo(() => {
    const ids = causalOrder([], projection.agents, leadId)
    return ids.includes(agentId) ? ids : [agentId, ...ids]
  }, [projection.agents, leadId, agentId])
  const evidenceIds = useMemo(() => {
    const map = new Map<string, string[]>()
    projection.evidence.forEach((item) => map.set(item.agentId, [...(map.get(item.agentId) ?? []), item.id]))
    return map
  }, [projection.evidence])
  const packetAgentIds = useMemo(() => new Set((packets ?? []).map((packet) => packet.agentId)), [packets])
  const node = useMemo<RunAgentsInput['doc']['nodes'][number]>(() => ({ id: agentId, type: 'agent', position: { x: 0, y: 0 }, selected: false, ariaLabel: name, data: { label: name, agent } }), [agentId, name, agent])
  // Every agent the run brought in is listed after it: Details lists them, it doesn't place them.
  const places = useMemo(() => Object.fromEntries(orderedAgentIds.map((id) => [id, { x: 0, y: 0 }])), [orderedAgentIds])
  const agents = useMemo(() => runAgentNodes({
    doc: { nodes: [node], edges: [], mode: record?.mode ?? 'team', entrypoint: agentId },
    session: { mode: session.mode, cursor: session.cursor },
    projection, record, phase: projection.phase, orderedAgentIds, evidenceByAgent: evidenceIds, leadId,
    waiting: record?.status === 'running' ? record.waitingOn ?? null : null,
    packetAgentIds, synthMeasurements: NO_POINTS, capabilityCards: NO_CARDS, allWiringEdges: NO_CARDS,
    helperPlacements: places, historicalPositions: null, guestNames: guests.names,
  }), [node, record, agentId, session.mode, session.cursor, projection, orderedAgentIds, evidenceIds, leadId, packetAgentIds, places, guests.names])
  const ownerLabels = useMemo(() => new Map(orderedAgentIds.map((id, index) => [id, ownerLabelFor(index, orderedAgentIds.length, id, names)])), [orderedAgentIds, names])

  // The answer, as a team's Details reads it: the responder's reply, as the run recorded it.
  const responder = projection.agents.find((each) => each.id === responderId)
  const recordedReply = record?.reply ?? null
  const recordedText = useMemo(() => (recordedReply != null ? recordedReplyText(session.events, responderId, recordedReply) : null), [session.events, responderId, recordedReply])
  const answer = session.cursor === null && recordedText != null ? recordedText : responder?.reply ?? ''
  const shownEvents = useMemo(() => (session.cursor === null ? session.events : session.events.filter((event) => event.seq <= (session.cursor ?? Infinity))), [session.events, session.cursor])
  const attempt = useMemo(() => {
    const all = teamRunIds(mergeHistory(runs, []), record?.teamPath ?? null)
    const index = all.indexOf(runId)
    return index >= 0 ? index + 1 : all.length + 1
  }, [runs, record?.teamPath, runId])
  const live = session.mode === 'live'
  const now = useNow(live && !isTerminalRun(record?.status))
  const ended = isTerminalRun(record?.status)
    ? record?.finishedAt ?? projection.updatedAt ?? null
    : !live ? projection.updatedAt ?? record?.finishedAt ?? null : new Date(now).toISOString()
  const elapsed = formatElapsed(projection.startedAt ?? record?.startedAt ?? record?.createdAt ?? null, ended)

  const evidence = inspected ? projection.evidence.find((item) => item.id === inspected) ?? null : null
  const handover = received ? {
    text: projection.agents.find((each) => each.id === received)?.received ?? '',
    toLabel: names.get(received) ?? received,
    fromLabel: (() => { const index = orderedAgentIds.indexOf(received); return index > 0 ? names.get(orderedAgentIds[index - 1]) ?? orderedAgentIds[index - 1] : 'the preceding stage' })(),
  } : null
  const allow = (id: string, key: AllowSwitch) => {
    if (id === agentId) onAllow(key)
    else void alwaysAllowGuest(id, key).catch(() => {})
  }

  return (
    <TeamFiguresContext.Provider value={figures}>
    <GuestNamesContext.Provider value={guests.names}>
      <div className="agent-answer agent-details" onKeyDown={(event) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.stopPropagation(); onClose() } }}>
        <button ref={back} type="button" className="link agent-answer-back" onClick={onClose}><ArrowLeft size={14} aria-hidden="true" />Back to {name}</button>
        <div className="agent-details-body" aria-label="Details of this piece of work" role="region">
          {session.loading ? <p className="tc-loading" role="status">Reading the run…</p> : (
            <DeliveryLane
              key={runId}
              harnessLabels={new Map([[agentId, modelLabelForAgent(agent)]])}
              pipeline={record?.mode === 'pipeline'}
              linearPipeline={false}
              onAllow={allow}
              prompt={record?.prompt ?? projection.prompt ?? ''} attempt={attempt} phase={projection.phase} elapsed={elapsed} mode={session.mode}
              agents={agents.filter((each) => !record?.onlyAgent || each.id === record.onlyAgent)}
              evidenceByAgent={new Map(orderedAgentIds.map((id) => [id, projection.evidence.filter((item) => item.agentId === id)]))}
              output={{ text: answer, producer: responder?.id ?? responderId }}
              projection={projection}
              record={record}
              events={shownEvents}
              focusAgentId={asked.agentId ?? null}
              onInspectEvidence={(id) => { setInspected(id); setReceived(null) }}
              onShowRecorded={() => setRecorded((open) => !open)}
              onShowReceived={(id) => { setReceived(id); setInspected(null) }}
              onRevealMessage={(id) => onRevealMessage(runId, id)}
            />
          )}
        </div>
        {evidence && <ActivityPanel evidence={evidence} ownerLabel={ownerLabels.get(evidence.agentId) ?? evidence.agentId} calls={projection.evidence.filter((item) => item.agentId === evidence.agentId)} finished={(agents.find((each) => each.id === evidence.agentId)?.data.runtime?.status ?? projection.agents.find((each) => each.id === evidence.agentId)?.status) === 'succeeded'} onInspectEvidence={setInspected} onClose={() => setInspected(null)} />}
        {handover && <HandoverPanel modal text={handover.text} toLabel={handover.toLabel} fromLabel={handover.fromLabel} packet={packets?.find((packet) => packet.agentId === received) ?? null} packetLoading={packets === null} onClose={() => setReceived(null)} />}
        {recorded && !evidence && <ProvenancePanel projection={projection} ownerLabels={ownerLabels} onInspect={setInspected} onClose={() => setRecorded(false)} />}
      </div>
    </GuestNamesContext.Provider>
    </TeamFiguresContext.Provider>
  )
}
