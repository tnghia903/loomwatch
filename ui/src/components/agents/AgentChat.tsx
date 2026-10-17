import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'

import { joinUnderRoot } from '../../lib/files/paths'
import { agentFromDraft, chatAgentId, chatTeamYaml, type AgentDraft } from '../../lib/library/draft'
import { figureHue, type FigureChoice } from '../../lib/library/figures'
import { benchFolder } from '../../lib/library/jobs'
import { knowledgeForChat, type TeamKnowledge } from '../../lib/library/teamDraft'
import { isTerminalRun, type RunRecord } from '../../lib/runs/client'
import { useRunSession } from '../../lib/runs/useRunSession'
import { ALLOW_SWITCHES } from '../../lib/team-file/allow'
import { fetchTeamFile, saveTeamFile } from '../../lib/team-file/client'
import type { AllowSwitch } from '../../lib/team-file/types'
import { AnswerDocument } from '../chat/AnswerDocument'
import { TeamChat, type Prepared } from '../chat/TeamChat'
import type { TeamView } from '../chat/WorkPiece'
import { TeamFiguresContext } from './figureContext'

export interface AgentChatProps {
  draft: AgentDraft
  /** The OpenRouter model it runs on. */
  model: string
  /**
   * Names the chat: the saved agent's id, or what a new one will be saved as. The chat's history
   * is kept under it, so saving a new agent under the same name keeps talking in the same chat.
   */
  chatId: string
  figure: FigureChoice
  /** "Allow from now on": switch this on in the draft, for the next message and every team. */
  onAllow: (key: AllowSwitch) => void
  /** The work the figure shows: the newest piece while it runs, and how it ended if you watched. */
  onRecord: (record: RunRecord | null) => void
  /** The piece whose long answer is read in full over the bench, and opening or closing one. */
  answerRunId: string | null
  onOpenAnswer: (runId: string | null) => void
  /**
   * Inside a team: what the team gives it to read, so its chat reads the same. Absent in Your
   * agents, where it reads nothing until a team gives it something (ADR 0042).
   */
  knowledge?: TeamKnowledge
}

const message = (failed: unknown) => (failed instanceof Error ? failed.message : String(failed))

/**
 * An agent's own chat (its Chat tab, in Your agents or in a team): you work with this one agent as
 * you would in a team's chat, with everything said before above it, while its figure works at the
 * bench beside.
 *
 * It is the team chat (ADR 0051) on a team of one, kept in the bench's hidden `.jobs/.bench/`
 * folder so no team list or schedule sees it. Each message that starts work first writes the agent
 * as it is on screen, saved or not, so a change made in Build is in its next answer. Every message
 * goes to the agent: it starts work when the agent is free and joins its turn while it works.
 */
export function AgentChat({ draft, model, chatId, figure, onAllow, onRecord, answerRunId, onOpenAnswer, knowledge }: AgentChatProps) {
  const agentId = chatAgentId(chatId)
  const name = draft.name.trim() || 'New agent'
  // A new agent's chat is kept under its name, so one with no name yet has nowhere to keep it.
  const blocked = !draft.name.trim() ? 'Give it a name in Build first: its chat is kept under it.'
    : !model ? 'Choose a model for it in Build first.' : !draft.instructions.trim() ? 'Write its instructions in Build first.' : null
  const [said, setSaid] = useState('')
  const announce = useCallback((text: string) => setSaid(text), [])

  // The chat's team file, written as the agent is now, for what is about to start.
  const write = useCallback(async (path: string): Promise<Prepared> => {
    if (!model) return { ok: false, error: blocked ?? 'Choose a model for it first.' }
    try {
      let revision: string | null = null
      try { revision = (await fetchTeamFile(path)).revision ?? null } catch { revision = null }
      const reads = knowledge ? knowledgeForChat(knowledge, path) : []
      const saved = await saveTeamFile(path, chatTeamYaml(draft, model, chatId, reads), revision)
      return { ok: true, revision: saved.revision ?? null }
    } catch (failed) {
      return { ok: false, error: `Couldn’t set up ${name}’s chat: ${message(failed)}` }
    }
  }, [draft, model, chatId, name, blocked, knowledge])

  // Where the chat is kept. An agent you have never talked to has no file yet: it is written once
  // it can be, so the chat has something to open.
  const [home, setHome] = useState<{ chatId: string; path: string | null; error: string | null } | null>(null)
  const writeNow = useRef(write)
  useEffect(() => { writeNow.current = write }, [write])
  const writable = !blocked
  const named = Boolean(draft.name.trim())
  useEffect(() => {
    if (!named) return
    let cancelled = false
    void (async () => {
      try {
        const path = joinUnderRoot(await benchFolder(), `${chatId}.yaml`)
        const exists = () => fetchTeamFile(path).then(() => true, () => false)
        const there = await exists()
        if (!there && !writable) { if (!cancelled) setHome({ chatId, path: null, error: null }); return }
        // Two openings at once (a second tab, or React's own double start) both find no file; the
        // one that loses the race to write it finds it written, which is all it needs.
        const ready = there ? { ok: true as const } : await writeNow.current(path)
        const opened = ready.ok || await exists()
        if (!cancelled) setHome(opened ? { chatId, path, error: null } : { chatId, path: null, error: ready.ok ? null : ready.error })
      } catch (failed) {
        if (!cancelled) setHome({ chatId, path: null, error: `Couldn’t open ${chatId}’s chat: ${message(failed)}` })
      }
    })()
    return () => { cancelled = true }
  }, [chatId, writable, named])
  const shown = !named ? { chatId, path: null, error: null } : home?.chatId === chatId ? home : null
  const path = shown?.path ?? null

  const prepare = useCallback(async (): Promise<Prepared> => (path ? write(path) : { ok: false, error: 'The chat isn’t open yet.' }), [path, write])

  const team = useMemo<TeamView>(() => ({
    names: new Map([[agentId, name]]),
    hues: new Map([[agentId, figureHue(figure)]]),
    parties: [{ id: agentId, name, operator: false }],
    predecessors: new Map(),
    order: [],
    operators: new Set(),
    configs: new Map([[agentId, { ...agentFromDraft(draft, model), id: agentId }]]),
    solo: agentId,
  }), [agentId, name, figure, draft, model])
  const agents = useMemo(() => [{ id: agentId, name }], [agentId, name])
  const figures = useMemo(() => new Map([[agentId, figure]]), [agentId, figure])

  // The figure shows the newest piece while it works, and how it ended once you saw it work: a
  // chat opened on finished work leaves it at rest.
  const watched = useRef(new Set<string>())
  const follow = useCallback((run: RunRecord | null) => {
    if (run && !isTerminalRun(run.status)) watched.current.add(run.runId)
    onRecord(run && watched.current.has(run.runId) ? run : null)
  }, [onRecord])
  useEffect(() => () => onRecord(null), [onRecord])

  // Its full record opens where every run's does: the team screen, on this chat, with Details. In a
  // tab of its own, so the agent on this page, and any change not saved yet, stay where they are.
  const details = useCallback((runId: string) => {
    if (path) window.open(`/?path=${encodeURIComponent(path)}&view=chat&run=${encodeURIComponent(runId)}`, '_blank', 'noopener')
  }, [path])

  if (!shown) return <section className="agent-chat-wait" aria-busy="true"><p className="t-meta">Opening {name}’s chat…</p></section>
  if (!path) {
    return (
      <section className="agent-chat-wait">
        <h3>Talk to {name}</h3>
        <p className={shown.error ? 'agent-bench-error' : 't-meta'} role={shown.error ? 'alert' : undefined}>{shown.error ?? blocked}</p>
      </section>
    )
  }
  return (
    <TeamFiguresContext.Provider value={figures}>
      <TeamChat
        key={path}
        teamPath={path}
        teamName={name}
        agents={agents}
        team={team}
        steps={1}
        suggestion={null}
        detailsRunId={null}
        answerRunId={answerRunId}
        onOpenAnswer={(runId) => onOpenAnswer(runId === answerRunId ? null : runId)}
        blocked={blocked}
        prepare={prepare}
        onDetails={details}
        onTeamReview={() => announce(`LoomWatch wants you to look over ${name}’s chat file before it runs. Open Details on any piece to see it.`)}
        onStale={() => announce(`${name}’s chat file changed while you were sending. Send your message again.`)}
        onAlwaysAllow={(_, key) => {
          onAllow(key)
          announce(`${name} may ${ALLOW_SWITCHES.find((item) => item.key === key)?.label.toLowerCase() ?? key} from now on. Save it to keep that.`)
        }}
        announce={announce}
        onOpenFinding={(runId) => details(runId)}
        onNewestRun={follow}
      />
      <p className="visually-hidden" role="status">{said}</p>
    </TeamFiguresContext.Provider>
  )
}

/**
 * A long answer from the chat, read in full over the bench (the team chat reads it in the pane
 * beside the chat). Its copy, save and review stay under its card in the chat.
 */
export function AgentAnswer({ runId, name, onClose }: { runId: string; name: string; onClose: () => void }) {
  const session = useRunSession(runId, null)
  const record = session.record
  const responder = session.projection.agents.find((agent) => agent.id === record?.responder)
  const text = record && isTerminalRun(record.status) ? record.reply ?? '' : responder?.reply ?? ''
  return (
    <div className="agent-answer" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
      <button type="button" className="link agent-answer-back" onClick={onClose}><ArrowLeft size={14} aria-hidden="true" />Back to {name} at the bench</button>
      <AnswerDocument text={text} by={name} streaming={!session.terminal} />
    </div>
  )
}
