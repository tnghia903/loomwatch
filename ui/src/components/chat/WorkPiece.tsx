import { ArrowRight, CalendarClock, ChevronDown, ChevronRight, FileText, PanelRight, RotateCcw, Square } from 'lucide-react'
import { lazy, Suspense, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'

import { AppearContext, useAppear } from '../../lib/chat/appear'
import { useFollow } from '../../lib/chat/follow'
import type { ChatItem, ChatMessage } from '../../lib/chat/client'
import { describeDocument, documentSize, isDocument } from '../../lib/chat/document'
import { clockTime, listNames, took } from '../../lib/chat/format'
import { answerRun, cancelRun, isTerminalRun, type RunRecord } from '../../lib/runs/client'
import { plainRunError } from '../../lib/runs/errors'
import { useRunSession } from '../../lib/runs/useRunSession'
import { fileRefsIn, withFolderPaths } from '../../lib/files/fileRefs'
import { checkAnswer, type AnswerCheck } from '../../lib/story/answerCheck'
import { APPROVAL_TEXT } from '../../lib/story/needsYou'
import type { Party } from '../../lib/story/conversation'
import type { ReceiptLine } from '../../lib/story/receipt'
import type { TeamMessage } from '../../lib/watch/messages'
import type { AgentConfig, AllowSwitch } from '../../lib/team-file/types'
import { PermissionActions, PermissionPrompt } from '../run/PermissionPrompt'
import { Markdown } from '../ui/Markdown'
import { AnswerTools } from './AnswerTools'
import { AgentFace } from './AgentFace'
import { Appearing, Swap } from './Appearing'

const AgentMessages = lazy(() => import('../run/AgentMessages').then((module) => ({ default: module.AgentMessages })))

/** The team as the chat draws it. */
export interface TeamView {
  names: ReadonlyMap<string, string>
  /** Each agent's colour, so its avatar and name match in every message. */
  hues: ReadonlyMap<string, number>
  parties: readonly Party[]
  predecessors: ReadonlyMap<string, readonly string[]>
  /** The pipeline order, empty for a team with no fixed order. */
  order: readonly string[]
  operators: ReadonlySet<string>
  /** Each agent's configuration from the team file: the skills its answer's review rests on. */
  configs?: ReadonlyMap<string, AgentConfig>
  /** The AI app each agent runs in, in words ("Claude", "Codex (not installed)"), for its card. */
  apps?: ReadonlyMap<string, string>
}

type Work = Extract<ChatItem, { kind: 'work' }>

interface WorkPieceProps {
  item: Work
  /** The run this one follows, when the chat has it: how "Continue with the team" is told apart. */
  followed: RunRecord | null
  /** Whether the team already continued from this piece, which retires its Continue. */
  continuedFrom: boolean
  /** The newest piece in the chat: its talk is shown, and the getting-started guide points here. */
  newest?: boolean
  /** A message the record beside the chat asked to show — the timeline's "Read the message". */
  reveal?: { id: string; at: number } | null
  team: TeamView
  /** The message box's draft: the note a review's buttons send. */
  draft: string
  /** The pane beside the chat shows this piece: its record, or its answer. */
  detailsOpen: boolean
  /** The pane beside the chat shows this piece's answer, as a document. */
  answerOpen: boolean
  onDetails: (runId: string) => void
  /** A document answer's card was opened: it is read in full in the pane beside the chat. */
  onOpenAnswer: (runId: string) => void
  onRun: (run: RunRecord) => void
  onTryAgain: (item: Work) => void
  onContinue: (runId: string) => Promise<void>
  /** A decision was sent with the draft as its note: the box is cleared. */
  onDecided: () => void
  onAlwaysAllow?: (agentId: string, key: AllowSwitch) => void
  /** A finding of the answer's review: its record, or the agent's work, opened in Details. */
  onOpenFinding: (runId: string, line: ReceiptLine) => void
}

/**
 * One piece of the team's work in its chat (ADR 0051): what you asked, the talk between the agents
 * folded to one line, what it waits on you for, and the answer. Work in progress is unfolded and
 * shows who is working; past work keeps its answer in view and its talk a click away. Details opens
 * the full record — stages, timeline, receipt — beside the chat.
 */
export function WorkPiece({ item, newest = false, reveal = null, followed, continuedFrom, team, draft, detailsOpen, answerOpen, onDetails, onOpenAnswer, onRun, onTryAgain, onContinue, onDecided, onAlwaysAllow, onOpenFinding }: WorkPieceProps) {
  const { run, request, notes } = item
  const live = !isTerminalRun(run.status)
  // What the agents said is shown where the work is happening — the newest piece, and any piece
  // still working — and folded once newer work arrives, unless you opened or closed it yourself.
  const [toggled, setToggled] = useState<boolean | null>(null)
  // The record beside the chat asking to show one of this piece's messages opens its talk.
  const [revealed, setRevealed] = useState(reveal)
  if (reveal !== revealed) {
    setRevealed(reveal)
    if (reveal) setToggled(true)
  }
  const open = toggled ?? (live || newest)
  const setOpen = (next: (value: boolean) => boolean) => setToggled(next(open))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // An answer says whether its record holds anything to check, so a piece reads its record once it
  // has been on screen — not every piece of a long history the moment the chat opens.
  const piece = useRef<HTMLLIElement>(null)
  const seen = useSeen(piece)
  // The record and its events: for work in progress, talk that is shown, and an answer you saw.
  const session = useRunSession(live || open || seen ? run.runId : null, run.responder)
  const name = (id: string) => team.names.get(id) ?? id
  const hue = (id: string) => team.hues.get(id) ?? 1
  // The session polls its own run every second; the chat page is the fallback between reads.
  const record = session.record?.runId === run.runId ? session.record : run
  // And the chat hears it, so the header's presence and the message box's label agree with this
  // piece rather than trailing it by a page read.
  const fresh = session.record?.runId === run.runId ? session.record : null
  useEffect(() => { if (fresh) onRun(fresh) }, [fresh, onRun])
  // A new piece fades in as one; what arrives in it afterwards — the answer, a question, a note's
  // fate — rises in on its own once the piece has painted.
  const appear = useAppear()
  const news = useContext(AppearContext)
  const [painted, setPainted] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setPainted(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  // The talk's history arrives in a first page of events; only what comes after it is news.
  const [talkSettled, setTalkSettled] = useState(false)
  const loaded = session.events.length > 0
  useEffect(() => {
    if (talkSettled || !loaded) return
    const frame = requestAnimationFrame(() => setTalkSettled(true))
    return () => cancelAnimationFrame(frame)
  }, [loaded, talkSettled])

  const took_ = took(run.startedAt ?? run.createdAt, run.finishedAt)
  const workers = workersOf(run, team)
  const working = (record.working ?? []).map(name)
  const waiting = live ? record.waitingOn ?? null : null
  const responder = session.projection.agents.find((agent) => agent.id === run.responder)
  const streamed = live ? responder?.reply ?? '' : ''
  const answer = isTerminalRun(record.status) ? record.reply ?? '' : streamed
  // Your review lasts while this chat is open, and only for the answer you reviewed.
  const [reviewedText, setReviewedText] = useState<string | null>(null)
  const streaming = live && responder?.taskState === 'STREAMING'
  const check = useMemo<AnswerCheck | null>(() => (
    loaded && answer
      ? checkAnswer({ record, projection: session.projection, parties: team.parties.map((party) => ({ ...party, config: team.configs?.get(party.id) })), answer, streaming, settled: session.evidenceComplete, reviewed: reviewedText === answer })
      : null
  ), [loaded, answer, record, session.projection, team.parties, team.configs, streaming, session.evidenceComplete, reviewedText])
  const continued = Boolean(run.followsRunId && followed?.onlyAgent && run.startAt && !run.onlyAgent)
  // A review or a question is answered on the message that asks, when the talk shows it; until
  // then (folded, or its events not read yet) it has a card of its own.
  const asksYou = Boolean(waiting) && session.projection.messages.some((message) =>
    message.state === 'pending' && !message.reply && (waiting?.kind === 'review_stop'
      ? message.kind === 'handover' && message.to === waiting.node
      : message.kind === 'question' && message.from === waiting?.node))
  const onTheMessage = open && asksYou
  // Answering something is following the work: what it asks next should come into view.
  const follow = useFollow()
  const pin = () => follow?.pin()
  const crew = team.parties.filter((party) => !party.operator).length > 1
  // A permission request is answered the same way: on the agent's message that asks, once the
  // talk shows it, and on a card of its own until then.
  const asking = live ? record.permissionRequests ?? [] : []
  const askedOnMessage = new Set(open ? session.projection.messages.flatMap((message) => (message.kind === 'permission' && message.state === 'pending' && message.permission ? [message.permission.requestId] : [])) : [])
  const unasked = asking.filter((request) => !askedOnMessage.has(request.id))
  const permissionTurn = (message: TeamMessage) => {
    const request = asking.find((candidate) => candidate.id === message.permission?.requestId)
    return request ? (
      <Appearing key={`permission:${request.id}`} reveal className="tc-turn permission" role="group" aria-label={`Answer ${request.name}'s permission request`}>
        <PermissionActions runId={run.runId} request={request} team={crew} onAlwaysAllow={onAlwaysAllow} onDecide={pin} />
      </Appearing>
    ) : undefined
  }

  const act = async (work: () => Promise<RunRecord | void>) => {
    setBusy(true)
    setError(null)
    try {
      const next = await work()
      if (next) onRun(next)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const approve = () => void act(async () => { pin(); const next = await answerRun(run.runId, waiting?.node ?? '', draft.trim() || APPROVAL_TEXT); onDecided(); return next })
  const sendBack = () => void act(async () => { pin(); const next = await answerRun(run.runId, waiting?.node ?? '', draft.trim(), waiting?.handoverFrom ?? undefined); onDecided(); return next })
  // Your turn, drawn on the message that asks: the review's buttons, or where to answer.
  const yourTurn = waiting?.kind === 'review_stop' ? (
    <Appearing key={`turn:${waiting.since}`} reveal className="tc-turn" role="group" aria-label={`Review ${name(waiting.handoverFrom ?? '')}'s work`}>
      <div className="tc-acts">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={approve}>{draft.trim() ? 'Approve with your note' : 'Approve'}</button>
        {waiting.sendBackAvailable && waiting.handoverFrom && (
          <button type="button" className="btn" disabled={busy || !draft.trim()} onClick={sendBack}>Send back to {name(waiting.handoverFrom)}</button>
        )}
      </div>
      {waiting.sendBackAvailable && !draft.trim() && <p className="tc-tip">To send it back, write what to change in the box below.</p>}
    </Appearing>
  ) : waiting?.kind === 'question' ? (
    <Appearing key={`turn:${waiting.since}`} reveal className="tc-turn question" role="group" aria-label={`${name(waiting.node)}'s question`}>
      <p className="tc-tip">Answer in the box below. {waiting.parkNote}</p>
    </Appearing>
  ) : null

  return (
    <AppearContext.Provider value={news && painted}>
    <li ref={piece} className={`tc-piece${live ? ' live' : ''}${newest ? ' newest' : ''}${detailsOpen ? ' in-details' : ''}${appear ? ' tc-appear-soft' : ''}`} data-run={run.runId}>
      <Request run={run} request={request} continuedFrom={continued ? name(run.startAt ?? '') : null} name={name} />
      {notes.map((note) => <Note key={note.id} note={note} live={live} name={name} />)}

      <div className="tc-talk" data-tour={newest ? 'stages' : undefined}>
        <Weft workers={workers} at={weftAt(workers, record, live, waiting)} live={live} waiting={Boolean(waiting) || asking.length > 0} status={record.status}>
          {workers.map((id) => <i key={id} className={`chat-avatar hue-${hue(id)}${live && record.working?.includes(id) ? ' working' : ''}`} style={{ width: 22, height: 22, fontSize: 9 }}>{initials(name(id))}</i>)}
        </Weft>
        <Swap key={talkKey(live, waiting, asking.map((request) => request.id), working, run.status)} className="tc-talk-line">
          {live
            ? waiting
              ? <><b className="tc-wait">Waiting for you</b> · {waiting.kind === 'review_stop' ? `${name(waiting.handoverFrom ?? '')}'s work is ready for your review` : `${name(waiting.node)} asked you something`}</>
              : asking.length > 0
                ? <><b className="tc-wait">Waiting for you</b> · {askers(asking.map((request) => name(request.agent)))} your permission</>
              : working.length > 0
                ? <><b>{listNames(working)}</b> {working.length === 1 ? 'is' : 'are'} working<span className="chat-dots" aria-hidden="true"><i /><i /><i /></span></>
                : run.status === 'queued' || run.status === 'starting' ? 'Starting…' : 'Handing over…'
            : `${listNames(workers.map(name))} worked on this${took_ ? ` · ${took_}` : ''}`}
        </Swap>
        <span className="tc-talk-acts">
          <button type="button" className="tc-link" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
            {open ? 'Hide what they said' : 'What they said'}
          </button>
          <button type="button" className="tc-link" onClick={() => onDetails(run.runId)} aria-pressed={detailsOpen && !answerOpen}>
            <PanelRight size={13} aria-hidden="true" />Details
          </button>
          {live && (
            <button type="button" className="tc-link danger" disabled={busy} onClick={() => void act(() => cancelRun(run.runId))}>
              <Square size={11} aria-hidden="true" />Stop
            </button>
          )}
        </span>
      </div>

      {open && (
        <div className="tc-said">
          <Suspense fallback={null}>
            <AppearContext.Provider value={news && painted && talkSettled}>
              <AgentMessages
                bare
                messages={session.projection.messages}
                order={team.parties}
                predecessors={team.predecessors}
                evidence={session.projection.evidence}
                live={live}
                onInspectEvidence={() => onDetails(run.runId)}
                reveal={revealed}
                yourTurn={onTheMessage ? yourTurn : undefined}
                permissionTurn={permissionTurn}
              />
            </AppearContext.Provider>
          </Suspense>
          {toggled && !live && session.projection.messages.length === 0 && loaded && <p className="chat-none">Nothing passed between the agents in this piece of work.</p>}
        </div>
      )}

      {live && !open && <Decisions messages={session.projection.messages} operators={team.operators} name={name} />}

      {waiting?.kind === 'review_stop' && !onTheMessage && (
        <Appearing key={`review:${waiting.since}`} reveal className="tc-decision" role="group" aria-label={`Review ${name(waiting.handoverFrom ?? '')}'s work`}>
          <p><b>{name(waiting.handoverFrom ?? '')}</b> handed over its work for your review.</p>
          {waiting.context && (
            <details className="tc-handover" open>
              <summary>Read the handover</summary>
              <div className="chat-text"><Markdown>{waiting.context}</Markdown></div>
            </details>
          )}
          <div className="tc-acts">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={approve}>
              {draft.trim() ? 'Approve with your note' : 'Approve'}
            </button>
            {waiting.sendBackAvailable && waiting.handoverFrom && (
              <button type="button" className="btn" disabled={busy || !draft.trim()} onClick={sendBack}>
                Send back to {name(waiting.handoverFrom)}
              </button>
            )}
          </div>
          {waiting.sendBackAvailable && !draft.trim() && <p className="tc-tip">To send it back, write what to change in the box below.</p>}
        </Appearing>
      )}
      {waiting?.kind === 'question' && !onTheMessage && (
        <Appearing key={`question:${waiting.since}`} reveal className="tc-decision question" role="group" aria-label={`${name(waiting.node)}'s question`}>
          <p><b>{name(waiting.node)}</b> asks you: {waiting.question}</p>
          {waiting.context && <div className="chat-text tc-context"><Markdown>{waiting.context}</Markdown></div>}
          <p className="tc-tip">Answer in the box below. {waiting.parkNote}</p>
        </Appearing>
      )}
      {unasked.length > 0 && <PermissionPrompt inline team={crew} run={{ runId: run.runId, permissionRequests: unasked }} onAlwaysAllow={onAlwaysAllow} onDecide={pin} />}

      <Outcome tour={newest} run={record} answer={answer} streaming={streaming} name={name} hue={hue} open={answerOpen} onOpen={() => onOpenAnswer(run.runId)} onTryAgain={() => onTryAgain(item)} onDetails={() => onDetails(run.runId)}>
        <AnswerTools
          run={record}
          answer={answer}
          check={check}
          files={isTerminalRun(record.status) ? fileRefsIn(answer) : []}
          makers={team.parties.filter((party) => !party.operator).map((party) => ({ id: party.id, name: party.name }))}
          finished={isTerminalRun(record.status)}
          reviewed={reviewedText === answer}
          onReviewed={() => setReviewedText(answer)}
          onOpenFinding={(line) => onOpenFinding(run.runId, line)}
        />
      </Outcome>

      {canContinue(record, team) && !continuedFrom && (
        <Appearing className="tc-continue">
          <button type="button" className="btn" disabled={busy} onClick={() => void act(() => onContinue(run.runId))}>
            Continue with the team<ArrowRight size={14} aria-hidden="true" />
          </button>
          <span className="tc-tip">{nextSteps(record, team, name)}</span>
        </Appearing>
      )}
      {error && <p className="chat-failed" role="alert">{error}</p>}
    </li>
    </AppearContext.Provider>
  )
}

/** Your answer to a permission request, in the line that remembers it. */
function permitted(message: TeamMessage, agent: string): string {
  const outcome = message.permission?.outcome
  if (outcome === 'allow_once') return `You let ${agent} do this once: ${message.text}`
  if (outcome === 'allow_run') return `You let ${agent} do this for the rest of the run: ${message.text}`
  if (outcome === 'allow_team') return `You let the whole team do this for the rest of the run: ${message.text}`
  return `You denied ${agent}: ${message.text}`
}

/**
 * What you decided while this piece worked — a review answered, a question answered — said where
 * you said it, so your own words do not vanish into the fold. Unfolded, the talk shows them.
 */
function Decisions({ messages, operators, name }: { messages: readonly TeamMessage[]; operators: ReadonlySet<string>; name: (id: string) => string }) {
  const yours = messages.filter((message) => message.reply && (operators.has(message.reply.from) || message.reply.from === 'operator') && (message.kind === 'handover' || message.kind === 'question' || message.kind === 'permission'))
  if (yours.length === 0) return null
  return (
    <>
      {yours.map((message) => {
        const reply = message.reply!
        // A handover is addressed to the review step; whose work it is, the record names.
        const whose = message.kind === 'question' ? message.from ?? '' : message.handedBy?.from[0] ?? message.from ?? ''
        const label = message.kind === 'permission'
          ? permitted(message, name(message.from ?? ''))
          : message.kind === 'question'
          ? `You → ${name(message.from ?? '')} · your answer to “${message.text.trim().slice(0, 80)}”`
          : reply.sentBackTo ? `You sent it back to ${name(reply.sentBackTo)}` : `You approved ${name(whose)}'s work`
        const quiet = message.kind === 'permission' || (message.kind === 'handover' && !reply.sentBackTo && reply.text.trim() === APPROVAL_TEXT)
        return (
          <Appearing key={message.id} className="chat-msg mine tc-decided">
            <div className="chat-stack">
              <div className="chat-meta"><span className="tc-to">{label}</span><time>{clockTime(reply.ts)}</time></div>
              {!quiet && <div className="chat-bubble"><div className="chat-text tc-plain">{reply.text}</div></div>}
            </div>
          </Appearing>
        )
      })}
    </>
  )
}

/** What started this piece: your message, the schedule's, or your Continue. */
function Request({ run, request, continuedFrom, name }: { run: RunRecord; request: ChatMessage | null; continuedFrom: string | null; name: (id: string) => string }) {
  if (continuedFrom) {
    return <div className="chat-notice"><span>You pressed Continue with the team · from {continuedFrom}</span><time>{clockTime(run.createdAt)}</time></div>
  }
  const text = request?.text ?? run.prompt
  const to = run.onlyAgent ? name(run.onlyAgent) : 'the team'
  if (run.trigger === 'schedule') {
    return (
      <div className="chat-msg">
        <span className="chat-gutter"><i className="chat-avatar hue-5 tc-schedule" style={{ width: 28, height: 28 }}><CalendarClock size={14} aria-hidden="true" /></i></span>
        <div className="chat-stack">
          <div className="chat-meta"><span className="chat-name hue-5">The schedule</span><span className="tc-to">to the team</span><time>{clockTime(run.createdAt)}</time></div>
          <div className="chat-bubble"><div className="chat-text"><Markdown>{text}</Markdown></div></div>
        </div>
      </div>
    )
  }
  return (
    <div className="chat-msg mine">
      <div className="chat-stack">
        <div className="chat-meta"><span className="tc-to">You → {to}</span><time>{clockTime(request?.createdAt ?? run.createdAt)}</time></div>
        <div className="chat-bubble"><div className="chat-text tc-plain">{text}</div></div>
      </div>
    </div>
  )
}

/** A note you sent into this piece while an agent worked. */
function Note({ note, live, name }: { note: ChatMessage; live: boolean; name: (id: string) => string }) {
  const appear = useAppear()
  const state = note.deliveredAt ? `${name(note.agentId ?? '')} took it in its next turn`
    : live ? note.now ? `Stopping ${name(note.agentId ?? '')}'s current step…` : `Waits for ${name(note.agentId ?? '')}'s current step to end`
      : 'The work ended before it was taken · kept for next time'
  return (
    <div className={`chat-msg mine tc-note${appear ? ' tc-appear' : ''}${note.deliveredAt ? ' taken' : ''}`}>
      <div className="chat-stack">
        <div className="chat-meta"><span className="tc-to">Note → {name(note.agentId ?? '')}</span><time>{clockTime(note.createdAt)}</time></div>
        <div className="chat-bubble"><div className="chat-text tc-plain">{note.text}</div></div>
        <div className="chat-under"><Swap key={state}>{state}</Swap></div>
      </div>
    </div>
  )
}

interface AnswerProps {
  tour: boolean
  run: RunRecord
  answer: string
  streaming: boolean
  name: (id: string) => string
  hue: (id: string) => number
  /** A document answer is open in the pane beside the chat. */
  open: boolean
  onOpen: () => void
  children: ReactNode
}

function Outcome({ onTryAgain, onDetails, ...answer }: AnswerProps & { onTryAgain: () => void; onDetails: () => void }) {
  if (answer.run.status === 'failed' || answer.run.status === 'cancelled') return <Stopped run={answer.run} name={answer.name} onTryAgain={onTryAgain} onDetails={onDetails} />
  if (!answer.answer.trim()) return null
  return <Answer {...answer} />
}

/** The work stopped: in plain words, with the way to try again. */
function Stopped({ run, name, onTryAgain, onDetails }: { run: RunRecord; name: (id: string) => string; onTryAgain: () => void; onDetails: () => void }) {
  if (run.status === 'failed') {
    return (
      <Appearing className="tc-stopped bad" role="status">
        <p><b>The work stopped.</b> {run.error ? plainRunError(run.error.split('\n')[0]) : run.errorCode === 'missing_canonical_response' ? `${name(run.responder)} finished without an answer.` : 'Its record says why.'}</p>
        <div className="tc-acts">
          <button type="button" className="btn" onClick={onTryAgain}><RotateCcw size={13} aria-hidden="true" />Try again</button>
          <button type="button" className="btn" onClick={onDetails}>See what happened</button>
        </div>
      </Appearing>
    )
  }
  return (
    <Appearing className="tc-stopped" role="status">
      <p>You stopped this.</p>
      <div className="tc-acts"><button type="button" className="btn" onClick={onTryAgain}><RotateCcw size={13} aria-hidden="true" />Try again</button></div>
    </Appearing>
  )
}

/**
 * The answer, beside who gave it; it rises in when it arrives while you watch. A short reply is a
 * message. A long one, or one with a title, is a document: a card with its title, its opening
 * words and its length, read in full in the pane beside the chat (lib/chat/document.ts).
 */
function Answer({ tour, run, answer, streaming, name, hue, open, onOpen, children }: AnswerProps) {
  const appear = useAppear()
  // Names listed under a folder read as files in the sentence too; copy and save keep the agent's words.
  const shown = useMemo(() => withFolderPaths(answer), [answer])
  const facts = useMemo(() => (isDocument(answer) ? describeDocument(answer) : null), [answer])
  const responder = run.responder
  return (
    <div className={`chat-msg tc-answer${appear ? ' tc-appear' : ''}`} data-tour={tour ? 'output' : undefined}>
      <span className="chat-gutter"><AgentFace id={responder}><i className={`chat-avatar hue-${hue(responder)}`} style={{ width: 28, height: 28 }} aria-hidden="true">{initials(name(responder))}</i></AgentFace></span>
      <div className="chat-stack">
        <div className={`chat-meta hue-${hue(responder)}`}><span className="chat-name">{name(responder)}</span><span className="tc-to">{run.onlyAgent ? 'to you' : "the team's answer"}</span><time>{clockTime(run.finishedAt)}</time></div>
        {facts ? (
          <button type="button" className={`tc-doc${open ? ' open' : ''}${streaming ? ' streaming' : ''}`} aria-pressed={open} aria-label={`${facts.title}, ${streaming ? 'being written' : documentSize(facts)}. ${open ? 'Showing beside the chat' : 'Open'}`} onClick={onOpen}>
            <span className="tc-doc-icon" aria-hidden="true"><FileText size={18} /></span>
            <span className="tc-doc-body">
              <b className="tc-doc-title">{facts.title}</b>
              {facts.preview && <span className="tc-doc-preview">{facts.preview}</span>}
              <span className="tc-doc-meta">
                <span>{streaming ? `Writing · ${documentSize({ words: facts.words, sections: 0 })}` : documentSize(facts)}</span>
                <span className="tc-doc-open">{open ? 'Showing' : 'Open'}{!open && <ArrowRight size={13} aria-hidden="true" />}</span>
              </span>
            </span>
          </button>
        ) : (
          <div className={`chat-bubble${streaming ? ' streaming' : ''}`} data-tick={streaming ? answer.length % 2 : undefined}>
            <div className="chat-text"><Markdown>{shown}</Markdown></div>
          </div>
        )}
        {children}
      </div>
    </div>
  )
}

/**
 * The team on a piece of work as a thread on a loom: each agent a knot, the thread gold as far as
 * the work has come, and a bead in the gap after whoever has it now — blue while it works, gold
 * while it waits on you. When the work passes on, the gold runs to the next agent and the bead
 * slides after it.
 */
function Weft({ workers, at, live, waiting, status, children }: { workers: readonly string[]; at: number; live: boolean; waiting: boolean; status: string; children: ReactNode }) {
  const many = workers.length > 1
  const fill = many ? Math.min(1, at / (workers.length - 1)) : 0
  return (
    <span className={`tc-weft${live ? ' live' : ''}${waiting ? ' waiting' : ''} st-${status}`} aria-hidden="true" style={{ '--weft-at': at, '--weft-fill': fill } as CSSProperties}>
      {many && <><i className="tc-weft-track" /><i className="tc-weft-fill" /></>}
      {children}
      {live && many && at < workers.length - 1 && <i className="tc-weft-bead" />}
    </span>
  )
}

/** How far along the thread the work has come: the agent that has it now, or the end once done. */
function weftAt(workers: readonly string[], run: RunRecord, live: boolean, waiting: RunRecord['waitingOn']): number {
  if (!live) return Math.max(0, workers.length - 1)
  const holder = waiting ? (waiting.kind === 'review_stop' ? waiting.handoverFrom ?? '' : waiting.node) : run.working?.[0] ?? ''
  const index = workers.indexOf(holder)
  return index >= 0 ? index : 0
}

/** What the talk line says, as a key: a change of who is working slides the new words in. */
function talkKey(live: boolean, waiting: RunRecord['waitingOn'], asking: readonly string[], working: readonly string[], status: string): string {
  if (!live) return 'done'
  if (waiting) return `waiting:${waiting.node}`
  if (asking.length > 0) return `asking:${asking.join(',')}`
  return working.length > 0 ? `working:${working.join(',')}` : status
}

/** "Researcher asks", "Researcher and Writer ask": who is waiting on your permission. */
function askers(names: readonly string[]): string {
  const once = [...new Set(names)]
  return `${listNames(once)} ${once.length === 1 ? 'asks' : 'ask'}`
}

/** Who worked on a piece, in the order they work. */
function workersOf(run: RunRecord, team: TeamView): string[] {
  if (run.onlyAgent) return [run.onlyAgent]
  if (team.order.length === 0) return [run.entrypoint]
  const start = run.startAt ? team.order.indexOf(run.startAt) : 0
  return team.order.slice(Math.max(0, start)).filter((id) => !team.operators.has(id))
}

/** "Continue with the team" is offered under a one-agent turn's new version when steps follow it. */
function canContinue(run: RunRecord, team: TeamView): boolean {
  if (!run.onlyAgent || run.status !== 'succeeded' || team.order.length === 0) return false
  const at = team.order.indexOf(run.onlyAgent)
  return at >= 0 && team.order.slice(at + 1).some((id) => !team.operators.has(id))
}

function nextSteps(run: RunRecord, team: TeamView, name: (id: string) => string): string {
  const at = team.order.indexOf(run.onlyAgent ?? '')
  const after = team.order.slice(at + 1)
  const reviewed = after[0] && team.operators.has(after[0])
  const next = after.filter((id) => !team.operators.has(id)).map(name)
  return `${reviewed ? 'Counts as your review, then ' : ''}${listNames(next)} ${next.length === 1 ? 'picks' : 'pick'} up from this version.`
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : name.slice(0, 2)).toUpperCase()
}

/** Whether an element has been on screen at least once. Where that cannot be told, it has. */
function useSeen(element: { current: Element | null }): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const target = element.current
    if (seen || !target) return
    const watcher = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) setSeen(true) })
    watcher.observe(target)
    return () => watcher.disconnect()
  }, [element, seen])
  return seen
}
