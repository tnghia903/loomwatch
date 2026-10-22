import { ArrowRight, CalendarClock, ChevronDown, ChevronRight, FileText, PanelRight, RotateCcw, Square } from 'lucide-react'
import { Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'

import { AppearContext, useAppear } from '../../lib/chat/appear'
import { agentResolver, batonWords, passesOf, useBaton, type Baton } from '../../lib/chat/baton'
import { useFollow } from '../../lib/chat/follow'
import type { ChatItem, ChatMessage, ReplyTo } from '../../lib/chat/client'
import { describeDocument, documentSize, isDocument } from '../../lib/chat/document'
import { helperOf, helpersOf, nameWithHelpers, wearerOf, whoWorks } from '../../lib/chat/helpers'
import { clockTime, listNames, took } from '../../lib/chat/format'
import { triesLine, tryingAgain } from '../../lib/chat/tries'
import { checkReactions, talkReactions, targets, yoursOn, type AgentReaction, type Face, type ReactionAbout } from '../../lib/chat/reactions'
import { answerRun, cancelRun, isTerminalRun, stopHelper, type RunRecord } from '../../lib/runs/client'
import { failedAgent, plainRunError, problemAction } from '../../lib/runs/errors'
import { openStops, stopSentence } from '../../lib/runs/spend'
import { useRunSession } from '../../lib/runs/useRunSession'
import { useNow } from '../../lib/useNow'
import { fileRefsIn, filesTouched, withFolderPaths } from '../../lib/files/fileRefs'
import { FileOriginContext } from '../../lib/files/reader'
import { checkAnswer, type AnswerCheck } from '../../lib/story/answerCheck'
import { APPROVAL_TEXT } from '../../lib/story/needsYou'
import { expectsAnswer, type Bubble, type Party } from '../../lib/story/conversation'
import type { ReceiptLine } from '../../lib/story/receipt'
import { OPERATOR_ID, type TeamMessage } from '../../lib/watch/messages'
import type { AutoRan } from '../../lib/watch/events'
import { workPhase } from '../../lib/watch/workPhase'
import type { AgentConfig } from '../../lib/team-file/types'
import type { AlwaysAllowed } from '../../lib/tools/allow'
import { AgentMessages } from '../run/AgentMessages'
import { ChatFiles } from './ChatFiles'
import { PermissionActions, PermissionPrompt } from '../run/PermissionPrompt'
import { SpendStopCard } from '../run/SpendStopCard'
import { Markdown } from '../ui/Markdown'
import { checkStopTip, checkStopTitle } from '../../lib/story/checkStop'
import { AnswerTools } from './AnswerTools'
import { Helpers } from './Helpers'
import { AgentFace } from './AgentFace'
import { AvatarFace } from '../agents/AvatarFace'
import { Appearing, Swap } from './Appearing'
import type { Lesson } from '../../lib/lessons/client'
import { Learned } from './Learned'
import { Reactions } from './Reactions'
import { Spool } from './Spool'
import { StatusGlyph } from '../ui/glyphs'
import { ReplyQuote } from './ReplyQuote'
import { SaidText } from './SaidText'


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
  /** The model each agent runs on, in words ("Claude Opus 5.5"), for its card. */
  models?: ReadonlyMap<string, string>
  /** An agent's own chat (Your agents): its one agent, whom all the work is with. There is no team. */
  solo?: string
}

type Work = Extract<ChatItem, { kind: 'work' }>

const NO_TRIES: readonly RunRecord[] = []

interface WorkPieceProps {
  item: Work
  /** The run this one follows, when the chat has it: how "Continue with the team" is told apart. */
  followed: RunRecord | null
  /** The routine's earlier tries at this same job, oldest first, folded into this piece. */
  earlier?: readonly RunRecord[]
  /** Whether the team already continued from this piece, which retires its Continue. */
  continuedFrom: boolean
  /** The newest piece in the chat: its talk is shown, and the getting-started guide points here. */
  newest?: boolean
  /** False while the chat waits on you for something newer, a review or a question: then this
   *  Approve is a gold ring, and the newest one's is the screen's one gold fill (DESIGN_LANGUAGE §8). */
  approveFilled?: boolean
  /** This piece's stop is the newest one LoomWatch knows how to fix, and nothing waits on you: its
   *  fix is the screen's one gold fill. Otherwise a gold ring (DESIGN_LANGUAGE §8). */
  fixFilled?: boolean
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
  /** Who has the work while this piece runs, each time that changes: what the chat's header shows. */
  onBaton?: (runId: string, baton: Baton | null) => void
  /** This piece's line, which says who has the work: the header shows its pill while it is out of view. */
  onLine?: (runId: string, element: HTMLElement | null) => void
  onTryAgain: (item: Work) => void
  onContinue: (runId: string) => Promise<void>
  /** A decision was sent with the draft as its note: the box is cleared. */
  onDecided: () => void
  onAlwaysAllow?: (agentId: string, what: AlwaysAllowed) => void
  /** A finding of the answer's review: its record, or the agent's work, opened in Details. */
  onOpenFinding: (runId: string, line: ReceiptLine) => void
  /** Reply to something said in this piece — what an agent said, or the answer (ADR 0051). */
  onReply?: (reply: ReplyTo) => void
  /** Show what one of your replies replied to, where it was said; absent when the chat cannot. */
  onShowReplied?: (reply: ReplyTo) => (() => void) | undefined
  /** Put your face on something said in this piece, or take it off. Absent, only the agents' faces show. */
  onReact?: (runId: string, target: string, face: Face | null, about?: ReactionAbout) => Promise<void>
  /** Take back something an agent learned from your feedback on this work (ADR 0078). */
  onUndoLesson?: (lesson: Lesson) => Promise<void>
  /** Move a lesson about you to About you, for every agent, once you said yes. */
  onTellAllLesson?: (lesson: Lesson) => Promise<void>
}

/**
 * One piece of the team's work in its chat (ADR 0051): what you asked, the talk between the agents
 * folded to one line, what it waits on you for, and the answer. Work in progress is unfolded and
 * shows who is working; past work keeps its answer in view and its talk a click away. Details opens
 * the full record — stages, timeline, receipt — beside the chat.
 */
export function WorkPiece({ item, newest = false, approveFilled = true, fixFilled = false, reveal = null, followed, earlier = NO_TRIES, continuedFrom, team, draft, detailsOpen, answerOpen, onDetails, onOpenAnswer, onRun, onBaton, onLine, onTryAgain, onContinue, onDecided, onAlwaysAllow, onOpenFinding, onReply, onShowReplied, onReact, onUndoLesson, onTellAllLesson }: WorkPieceProps) {
  const { run, request, notes } = item
  const live = !isTerminalRun(run.status)
  // What the agents said is shown where the work is happening — the newest piece, and any piece
  // still working — and folded once newer work arrives, unless you opened or closed it yourself.
  const [toggled, setToggled] = useState<boolean | null>(null)
  // The record beside the chat asking to show one of this piece's messages opens its talk.
  const [revealed, setRevealed] = useState(reveal)
  // A reply's quote can point at the answer itself, which is always in view: it is flashed, and
  // the talk stays as it is.
  const answerKey = `answer:${run.runId}`
  // The files the answer names are read beside the chat, and asked about, as this agent's work.
  const fileOrigin = useMemo(() => ({ runId: run.runId, from: run.responder }), [run.runId, run.responder])
  const [answerFlash, setAnswerFlash] = useState<number | null>(null)
  // Your request, or a note you sent into the work, found by a search (ADR 0081): ringed in place.
  const [saidFlash, setSaidFlash] = useState<{ id: string; at: number } | null>(null)
  const yours = (id: string) => id === `request:${run.runId}` || notes.some((note) => id === `note:${note.id}`)
  if (reveal !== revealed) {
    setRevealed(reveal)
    if (reveal?.id === answerKey) setAnswerFlash(reveal.at)
    else if (reveal && yours(reveal.id)) setSaidFlash({ id: reveal.id, at: reveal.at })
    else if (reveal) setToggled(true)
  }
  const open = toggled ?? (live || newest)
  const setOpen = (next: (value: boolean) => boolean) => setToggled(next(open))
  // A helper's row (ADR 0079) opens the talk at the brief its agent wrote it.
  const [shown, setShown] = useState<{ id: string; at: number } | null>(null)
  const showMessage = useCallback((id: string) => { setShown({ id, at: Date.now() }); setToggled(true) }, [])
  const talkReveal = shown && (!revealed || shown.at > revealed.at) ? shown : revealed
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // An answer says whether its record holds anything to check, so a piece reads its record once it
  // has been on screen — not every piece of a long history the moment the chat opens.
  const piece = useRef<HTMLLIElement>(null)
  const seen = useSeen(piece)
  useEffect(() => {
    if (saidFlash === null) return
    piece.current?.querySelector(`[data-said="${CSS.escape(saidFlash.id)}"]`)?.scrollIntoView?.({ block: 'center' })
    const timer = window.setTimeout(() => setSaidFlash(null), 1800)
    return () => window.clearTimeout(timer)
  }, [saidFlash])
  useEffect(() => {
    if (answerFlash === null) return
    piece.current?.querySelector('.tc-answer')?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
    const timer = window.setTimeout(() => setAnswerFlash(null), 1800)
    return () => window.clearTimeout(timer)
  }, [answerFlash])
  // The record and its events: for work in progress, talk that is shown, and an answer you saw.
  const session = useRunSession(live || open || seen ? run.runId : null, run.responder)
  // A helper (ADR 0079) is named after the agent it helps, and wears its colour.
  const name = (id: string) => nameWithHelpers(team.names, id) ?? id
  const hue = (id: string) => team.hues.get(wearerOf(id)) ?? 1
  // The session polls its own run every second; the chat page is the fallback between reads.
  const record = session.record?.runId === run.runId ? session.record : run
  // Whether the schedule tries it again is said as the run ends. The session's copy sees the end
  // first; once the chat's copy has seen it too, that one is kept fresh, as when the try starts.
  const ended = isTerminalRun(run.status) ? run : record
  const tries = triesLine(ended, earlier)
  // And the chat hears it, so the header's presence and the message box's label agree with this
  // piece rather than trailing it by a page read.
  const fresh = session.record?.runId === run.runId ? session.record : null
  useEffect(() => { if (fresh) onRun(fresh) }, [fresh, onRun])
  // And where the work is as it moves between the agents (lib/chat/baton.ts); none once it ends.
  const resolve = useMemo(() => agentResolver(team.names, team.operators), [team.names, team.operators])
  const passes = useMemo(() => (live ? passesOf(session.projection.messages, resolve) : []), [live, session.projection.messages, resolve])
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
  const working = record.working ?? []
  const waiting = live ? record.waitingOn ?? null : null
  const responder = session.projection.agents.find((agent) => agent.id === run.responder)
  // Work a check step checks is not the answer until the checks are done (ADR 0062): it may yet
  // go back, or wait for you to approve it. Before then it is only in what the agents said.
  const checked = [...(team.configs?.values() ?? [])].some((config) => config.checks === run.responder)
  const streamed = live && !checked ? responder?.reply ?? '' : ''
  const answer = isTerminalRun(record.status) ? record.reply ?? '' : streamed
  // Whoever is writing now (lib/watch/workPhase.ts), its figure typing at the bench, is typing in
  // the chat too: its face and a bubble of dots under the work. Not twice: the answer coming in, or
  // a reply the talk shows it owes, already says so.
  const now = useNow(live)
  // A helper writes to its agent, not to you: only the agent types in the chat.
  const typing = (live ? record.working ?? [] : [])
    .filter((id) => !helperOf(id) && workPhase(session.events, id, now) === 'typing')
    .filter((id) => !(id === run.responder && answer.trim()) && !(open && owesReply(session.projection.messages, id, resolve)))
  // The helpers its agent brought in (ADR 0079), read off the piece's own record.
  const helpers = useMemo(() => helpersOf(session.events, session.projection.evidence), [session.events, session.projection.evidence])
  // The files the answer names, for its tools: a scan of the whole text, so once per answer. An
  // agent names a file from its own folder ("./guide.html"); what it read or wrote, else where it
  // works, says which.
  const finishedAnswer = isTerminalRun(record.status)
  const touched = useMemo(() => filesTouched(session.projection.evidence), [session.projection.evidence])
  const folder = responder?.folder ?? null
  const answerFiles = useMemo(() => (finishedAnswer ? fileRefsIn(answer, touched, folder) : []), [finishedAnswer, answer, touched, folder])
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
  // talk shows it, and on a card of its own until then. Answered there, it is over at once, though
  // the run's record (polled each second) still lists it for a moment: then nothing asks it again.
  const settled = new Set(session.projection.messages.flatMap((message) => (message.kind === 'permission' && message.permission?.outcome ? [message.permission.requestId] : [])))
  const asking = live ? (record.permissionRequests ?? []).filter((request) => !settled.has(request.id)) : []
  // The run used what it may spend, or an agent its own guard (ADR 0068): those agents wait on you.
  const stops = live ? openStops(record) : []
  const atSpool = stops.flatMap((stop) => (stop.agent ? [stop.agent] : record.working ?? []))
  // Each figure on the piece's line glows what it is doing: asking you (gold), at work (blue), or,
  // once the piece is over, the one it stopped at (red).
  const stoppedAt = failedAgent(record)
  const askingYou = new Set([...asking.map((request) => request.agent), ...atSpool, ...(waiting ? [waiting.kind === 'review_stop' ? waiting.handoverFrom ?? waiting.node : waiting.node] : [])])
  const weftState = (id: string) => (live ? (askingYou.has(id) ? 'waiting' : record.working?.includes(id) ? 'working' : '') : stoppedAt === id ? 'failed' : '')
  const askedOnMessage = new Set(open ? session.projection.messages.flatMap((message) => (message.kind === 'permission' && message.state === 'pending' && message.permission ? [message.permission.requestId] : [])) : [])
  const unasked = asking.filter((request) => !askedOnMessage.has(request.id))
  // Who has the work now: said on this piece's line, and on the header's pill while the line is out
  // of view. An agent waiting on you has it first.
  const waitingOn = waiting ? (waiting.kind === 'review_stop' ? waiting.handoverFrom ?? waiting.node : waiting.node) : asking[0]?.agent ?? atSpool[0] ?? null
  const baton = useBaton({ passes, working: live ? record.working ?? [] : [], waitingOn })
  useEffect(() => { onBaton?.(run.runId, live ? baton : null) }, [onBaton, run.runId, live, baton])
  useEffect(() => () => onBaton?.(run.runId, null), [onBaton, run.runId])
  const lineRef = useCallback((element: HTMLDivElement | null) => onLine?.(run.runId, element), [onLine, run.runId])
  // A pass is named on the line; plain work keeps saying who is working.
  const pass = live && baton && baton.kind !== 'working' && baton.kind !== 'you' ? baton : null
  const passLine = pass ? batonWords(pass, name).line : null
  // Reactions (lib/chat/reactions.ts). Yours go on anything said — the agents' answer and talk,
  // and your own words — and tell the team next time. The agents' faces are receipts read from the
  // record: whoever took the work up looks up at what it was handed.
  const checks = useMemo(() => checkReactions(session.projection.messages), [session.projection.messages])
  const reactOn = (target: string, about: string, agents: readonly AgentReaction[], { what, mine = false, own = mine }: { what?: ReactionAbout; mine?: boolean; own?: boolean } = {}) => (said: ReactNode) => (
    <Reactions yours={yoursOn(item.reactions, target)} agents={agents} about={about} name={name} hue={hue} mine={mine} own={own} onReact={onReact && ((face) => onReact(run.runId, target, face, what))}>{said}</Reactions>
  )
  const isYou = (id: string | undefined) => id === OPERATOR_ID || (id !== undefined && team.operators.has(id))
  const talkReacts = (bubble: Bubble, said: ReactNode) => {
    const speaker = bubble.from[0]
    const agents = talkReactions(bubble, team.operators, checks)
    if (isYou(speaker) || !speaker) return reactOn(targets.mine(bubble), `your ${bubble.word}`, agents, { what: { agent: null, what: bubble.word, quote: bubble.text }, mine: isYou(speaker), own: true })(said)
    return reactOn(targets.talk(bubble), `${name(speaker)}'s ${bubble.word}`, agents, { what: { agent: speaker, what: bubble.word, quote: bubble.text } })(said)
  }
  // Your request carries who took it up while the work runs, and once it is done, everyone who
  // worked on it and how long it took, as their faces rather than a line of words.
  const onRequest: AgentReaction[] = record.status === 'succeeded'
    ? workers.map((id) => ({ face: 'done', by: id, at: record.finishedAt ?? record.createdAt, detail: took_ || undefined }))
    : pickedUpBy(workers[0], record, session.projection.agents)
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

  const approveClass = `btn ${approveFilled ? 'btn-primary' : 'btn-ring'}`
  const approve = () => void act(async () => { pin(); const next = await answerRun(run.runId, waiting?.node ?? '', draft.trim() || APPROVAL_TEXT); onDecided(); return next })
  const sendBack = () => void act(async () => { pin(); const next = await answerRun(run.runId, waiting?.node ?? '', draft.trim(), waiting?.handoverFrom ?? undefined); onDecided(); return next })
  // Your turn, drawn on the message that asks: the review's buttons, or where to answer.
  const yourTurn = waiting?.kind === 'review_stop' ? (
    <Appearing key={`turn:${waiting.since}`} reveal className="tc-turn" role="group" aria-label={`Review ${name(waiting.handoverFrom ?? '')}'s work`}>
      <div className="tc-acts">
        <button type="button" className={approveClass} disabled={busy} onClick={approve}>{draft.trim() ? 'Approve with your note' : 'Approve'}</button>
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
      <Request run={run} request={request} flash={saidFlash?.id === `request:${run.runId}`} continuedFrom={continued ? name(run.startAt ?? '') : null} name={name} solo={team.solo} onShowReplied={onShowReplied} reactions={reactOn(targets.request, run.trigger === 'schedule' ? "the schedule's request" : 'your request', onRequest, { mine: run.trigger !== 'schedule', own: true })} />
      {notes.map((note) => <Note key={note.id} note={note} flash={saidFlash?.id === `note:${note.id}`} live={live} name={name} onShowReplied={onShowReplied} reactions={reactOn(targets.note(note.id), `your note to ${name(note.agentId ?? '')}`, note.deliveredAt && note.agentId ? [{ face: 'seen', by: note.agentId, at: note.deliveredAt }] : [], { mine: true })} />)}
      {tries && !tryingAgain(ended) && <div className="chat-notice tc-tries"><span>{tries}</span></div>}

      <div ref={lineRef} className="tc-talk" data-tour={newest ? 'stages' : undefined}>
        {/* Done, the faces on your request say who worked on it; the line says only what is still happening. */}
        {record.status !== 'succeeded' && (
          <Weft workers={workers} at={weftAt(workers, record, live, waiting)} live={live} waiting={Boolean(waiting) || asking.length > 0 || stops.length > 0} status={record.status}>
            {workers.map((id) => <AvatarFace key={id} id={id} hue={hue(id)} size={22} fontSize={9} text={initials(name(id))} className={weftState(id)} />)}
          </Weft>
        )}
        {live && <Swap key={talkKey(live, waiting, [...asking.map((request) => request.id), ...stops.map((stop) => stop.id)], working, run.status, pass)} className="tc-talk-line">
          {waiting
            ? <><b className="tc-wait">Waiting for you</b> · {waiting.check ? checkStopTitle(waiting.check, name, name(waiting.node)).replace(/\.$/, '') : waiting.kind === 'review_stop' ? `${name(waiting.handoverFrom ?? '')}'s work is ready for your review` : `${name(waiting.node)} asked you something`}</>
            : asking.length > 0
              ? <><b className="tc-wait">Waiting for you</b> · {askers(asking.map((request) => name(request.agent)))} your permission</>
            : stops.length > 0
              ? <><b className="tc-wait">Waiting for you</b> · {stopSentence(stops[0]).replace(/\.$/, '')}</>
            : passLine
              ? <>{passLine.map((part, index) => (part.agent ? <Named key={index} hue={hue(part.agent)}>{part.text}</Named> : <Fragment key={index}>{part.text}</Fragment>))}<span className="chat-dots" aria-hidden="true"><i /><i /><i /></span></>
            : working.length > 0
              ? <><span>{whoWorks(working).map((part, index, parts) => <Fragment key={part.agent ?? part.text}>{index === 0 ? '' : index === parts.length - 1 ? ' and ' : ', '}{part.agent ? <Named hue={hue(part.agent)}>{part.helpers ? `${name(part.agent)}’s ${part.text}` : name(part.agent)}</Named> : part.text}</Fragment>)}</span> {working.length === 1 ? 'is' : 'are'} working<span className="chat-dots" aria-hidden="true"><i /><i /><i /></span></>
              : run.status === 'queued' || run.status === 'starting' ? 'Starting…' : 'Handing over…'}
        </Swap>}
        <Spool spend={record.spend} stops={stops} name={name} hue={hue} />
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

      {helpers.length > 0 && <Helpers helpers={helpers} live={live} lead={name(helpers[0].lead)} name={name} hue={hue} onShow={showMessage} onStop={async (helper) => { await stopHelper(run.runId, helper) }} />}

      {open && (
        <div className="tc-said">
          <AppearContext.Provider value={news && painted && talkSettled}>
            <AgentMessages
              bare
              messages={session.projection.messages}
              order={team.parties}
              predecessors={team.predecessors}
              evidence={session.projection.evidence}
              live={live}
              onInspectEvidence={() => onDetails(run.runId)}
              reveal={talkReveal}
              yourTurn={onTheMessage ? yourTurn : undefined}
              permissionTurn={permissionTurn}
              onReply={onReply ? (reply) => onReply({ ...reply, runId: run.runId }) : undefined}
              reactions={talkReacts}
            />
          </AppearContext.Provider>
          {toggled && !live && session.projection.messages.length === 0 && loaded && <p className="chat-none">Nothing passed between the agents in this piece of work.</p>}
        </div>
      )}

      {live && !open && <Decisions messages={session.projection.messages} autoRan={session.projection.autoRan} operators={team.operators} name={name} />}

      {waiting?.kind === 'review_stop' && waiting.check && (
        <Appearing key={`check:${waiting.since}`} reveal className="tc-decision check-stop" role="group" aria-label={`Decide on ${name(waiting.check.checked)}'s work`}>
          <p><b>{checkStopTitle(waiting.check, name, name(waiting.node))}</b></p>
          <ul className="tc-check-misses" aria-label="Checks still not met">
            {waiting.check.items.map((item, index) => (
              <li key={index}>
                <span className={`tc-check-verdict ${item.verdict}`}>{item.verdict === 'not_met' ? 'Not met' : 'Not sure'}</span> {item.item}
                {item.evidence && <span className="t-meta"> — {item.evidence}</span>}
              </li>
            ))}
          </ul>
          {waiting.check.problems && (
            <details className="tc-handover">
              <summary>What {name(waiting.node)} wrote about it</summary>
              <div className="chat-text"><Markdown>{waiting.check.problems}</Markdown></div>
            </details>
          )}
          {waiting.context && (
            <details className="tc-handover">
              <summary>Read {name(waiting.check.checked)}’s work</summary>
              <div className="chat-text"><Markdown>{waiting.context}</Markdown></div>
            </details>
          )}
          <div className="tc-acts">
            <button type="button" className={approveClass} disabled={busy} onClick={approve}>
              {draft.trim() ? 'Approve with your note' : 'Approve as it is'}
            </button>
            {waiting.sendBackAvailable && waiting.handoverFrom && (
              <button type="button" className="btn" disabled={busy || !draft.trim()} onClick={sendBack}>
                Send back to {name(waiting.handoverFrom)}
              </button>
            )}
          </div>
          <p className="tc-tip">{waiting.sendBackAvailable ? checkStopTip(waiting.check, name, name(waiting.node)) : 'Approve keeps the work as it is, with what wasn’t met marked on it.'}</p>
        </Appearing>
      )}
      {waiting?.kind === 'review_stop' && !waiting.check && !onTheMessage && (
        <Appearing key={`review:${waiting.since}`} reveal className="tc-decision" role="group" aria-label={`Review ${name(waiting.handoverFrom ?? '')}'s work`}>
          <p><b>{name(waiting.handoverFrom ?? '')}</b> handed over its work for your review.</p>
          {waiting.context && (
            <details className="tc-handover" open>
              <summary>Read the handover</summary>
              <div className="chat-text"><Markdown>{waiting.context}</Markdown></div>
            </details>
          )}
          <div className="tc-acts">
            <button type="button" className={approveClass} disabled={busy} onClick={approve}>
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
      {stops.length > 0 && <SpendStopCard inline run={{ runId: run.runId, spendStops: stops }} onDecide={pin} onRun={onRun} />}
      {/* Who is writing is read off the events too: it is news only once their first page is in. */}
      <AppearContext.Provider value={news && painted && talkSettled}>
        {typing.map((id) => <Writing key={`typing:${id}`} id={id} at={session.events.findLast((event) => event.agentId === id && event.kind === 'message')?.ts} name={name} hue={hue} />)}
      </AppearContext.Provider>

      <FileOriginContext.Provider value={fileOrigin}>
      <Outcome tour={newest} run={record} tries={tryingAgain(ended) ? tries : null} fixFilled={fixFilled} answer={answer} touched={touched} folder={folder} streaming={streaming} name={name} hue={hue} open={answerOpen} flash={answerFlash !== null} solo={Boolean(team.solo)} reactions={reactOn(targets.answer, `${name(record.responder)}'s answer`, [])} onOpen={() => onOpenAnswer(run.runId)} onTryAgain={() => onTryAgain(item)} onDetails={() => onDetails(run.runId)}>
        <AnswerTools
          run={record}
          answer={answer}
          check={check}
          files={answerFiles}
          makers={team.parties.filter((party) => !party.operator).map((party) => ({ id: party.id, name: party.name }))}
          finished={isTerminalRun(record.status)}
          reviewed={reviewedText === answer}
          onReviewed={() => setReviewedText(answer)}
          onOpenFinding={(line) => onOpenFinding(run.runId, line)}
          onReply={onReply && answer.trim() ? () => onReply({ runId: run.runId, messageId: answerKey, from: run.responder, to: null, kind: 'answer', text: answer }) : undefined}
          replyLabel={`Reply to ${name(run.responder)}'s answer`}
        />
      </Outcome>
      </FileOriginContext.Provider>
      {item.lessons && <Learned lessons={item.lessons} name={name} onUndo={onUndoLesson} onTellAll={onTellAllLesson} />}

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

/**
 * Whether the talk shows `agent` owing a reply (lib/story/conversation.ts), drawn as its dots. An
 * open ask names the agent as it was written; `resolve` finds it as the bus will.
 */
function owesReply(messages: readonly TeamMessage[], agent: string, resolve: (written: string | null) => string | null): boolean {
  // The talk leaves out what was carried over from the work this follows.
  return messages.some((message) => message.state === 'pending' && !message.reply && !message.carried && expectsAnswer(message.kind) && resolve(message.to) === agent)
}

/** An agent writing now: its face, its name, and a bubble of dots that says so; it rises in only as news. */
function Writing({ id, at, name, hue }: { id: string; at: string | undefined; name: (id: string) => string; hue: (id: string) => number }) {
  const appear = useAppear()
  return (
    <div className={`chat-msg tc-typing${appear ? ' tc-appear' : ''}`} role="status" aria-label={`${name(id)} is writing`}>
      <span className="chat-gutter"><AgentFace id={id}><AvatarFace id={id} hue={hue(id)} size={28} text={initials(name(id))} /></AgentFace></span>
      <div className="chat-stack">
        <div className={`chat-meta hue-${hue(id)}`}><span className="chat-name">{name(id)}</span><time>{clockTime(at)}</time></div>
        <div className="chat-bubble typing"><span className="chat-dots" aria-hidden="true"><i /><i /><i /></span><span className="chat-typing-word">{name(id)} is writing</span></div>
      </div>
    </div>
  )
}

/** Your answer to a permission request, in the line that remembers it. */
function permitted(message: TeamMessage, agent: string): string {
  const outcome = message.permission?.outcome
  if (outcome === 'allow_once') return `You let ${agent} do this once: ${message.text}`
  if (outcome === 'allow_run') return `You let ${agent} do this for the rest of the run: ${message.text}`
  if (outcome === 'allow_team') return `You let the whole team do this for the rest of the run: ${message.text}`
  if (outcome === 'edited') return `You changed it, then let ${agent} run it: ${message.permission?.written ?? message.text}`
  if (outcome === 'answered') return `You answered ${agent} instead: “${message.permission?.written ?? ''}”`
  return `You denied ${agent}: ${message.text}`
}

/**
 * What you decided while this piece worked — a review answered, a question answered — said where
 * you said it, so your own words do not vanish into the fold. Unfolded, the talk shows them.
 */
function Decisions({ messages, autoRan = [], operators, name }: { messages: readonly TeamMessage[]; autoRan?: readonly AutoRan[]; operators: ReadonlySet<string>; name: (id: string) => string }) {
  const yours = messages.filter((message) => message.reply && (operators.has(message.reply.from) || message.reply.from === 'operator') && (message.kind === 'handover' || message.kind === 'question' || message.kind === 'permission'))
  if (yours.length === 0 && autoRan.length === 0) return null
  const lastAuto = autoRan.at(-1)
  return (
    <>
      {/* ADR 0061: what Auto mode ran in your place, said once rather than once per command. */}
      {lastAuto && (
        <Appearing key={`auto:${autoRan.length}`} className="chat-msg mine tc-decided">
          <div className="chat-stack">
            <div className="chat-meta">
              <span className="tc-to" title={autoRan.map((ran) => `${name(ran.agentId)}: ${ran.detail ?? ran.title}`).join('\n')}>
                {autoRan.length === 1 ? `Auto mode let ${name(lastAuto.agentId)} run ${lastAuto.detail ?? lastAuto.title}` : `Auto mode ran ${autoRan.length} commands without asking you · latest ${lastAuto.detail ?? lastAuto.title}`}
              </span>
              <time>{clockTime(lastAuto.ts)}</time>
            </div>
          </div>
        </Appearing>
      )}
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
function Request({ run, request, flash = false, continuedFrom, name, solo, onShowReplied, reactions }: { run: RunRecord; request: ChatMessage | null; flash?: boolean; continuedFrom: string | null; name: (id: string) => string; solo?: string; onShowReplied?: (reply: ReplyTo) => (() => void) | undefined; reactions: (said: ReactNode) => ReactNode }) {
  if (continuedFrom) {
    return <div className={`chat-notice${flash ? ' flash' : ''}`} data-said={`request:${run.runId}`}><span>You pressed Continue with the team · from {continuedFrom}</span><time>{clockTime(run.createdAt)}</time></div>
  }
  const text = request?.text ?? run.prompt
  const to = run.onlyAgent ? name(run.onlyAgent) : solo ? name(solo) : 'the team'
  if (run.trigger === 'schedule') {
    return (
      <div className={`chat-msg${flash ? ' flash' : ''}`} data-said={`request:${run.runId}`}>
        <span className="chat-gutter"><i className="chat-avatar hue-quiet tc-schedule" style={{ width: 28, height: 28 }}><CalendarClock size={14} aria-hidden="true" /></i></span>
        <div className="chat-stack">
          <div className="chat-meta"><span className="chat-name hue-quiet">The schedule</span><span className="tc-to">to the team</span><time>{clockTime(run.createdAt)}</time></div>
          {reactions(<div className="chat-bubble"><div className="chat-text"><Markdown>{text}</Markdown></div></div>)}
        </div>
      </div>
    )
  }
  return (
    <div className={`chat-msg mine${flash ? ' flash' : ''}`} data-said={`request:${run.runId}`}>
      <div className="chat-stack">
        <div className="chat-meta"><span className="tc-to">You → {to}</span><time>{clockTime(request?.createdAt ?? run.createdAt)}</time></div>
        {reactions(<div className="chat-bubble">
          {request?.replyTo && <ReplyQuote reply={request.replyTo} name={name} onShow={onShowReplied?.(request.replyTo)} />}
          {request?.files && <ChatFiles files={request.files} />}
          <div className="chat-text tc-plain"><SaidText text={text} /></div>
        </div>)}
      </div>
    </div>
  )
}

/** A note you sent into this piece while an agent worked. */
function Note({ note, flash = false, live, name, onShowReplied, reactions }: { note: ChatMessage; flash?: boolean; live: boolean; name: (id: string) => string; onShowReplied?: (reply: ReplyTo) => (() => void) | undefined; reactions: (said: ReactNode) => ReactNode }) {
  const appear = useAppear()
  const state = note.deliveredAt ? `${name(note.agentId ?? '')} took it in its next turn`
    : live ? note.now ? `Stopping ${name(note.agentId ?? '')}'s current step…` : `Waits for ${name(note.agentId ?? '')}'s current step to end`
      : 'The work ended before it was taken · kept for next time'
  return (
    <div className={`chat-msg mine tc-note${appear ? ' tc-appear' : ''}${note.deliveredAt ? ' taken' : ''}${flash ? ' flash' : ''}`} data-said={`note:${note.id}`}>
      <div className="chat-stack">
        <div className="chat-meta"><span className="tc-to">Note → {name(note.agentId ?? '')}</span><time>{clockTime(note.createdAt)}</time></div>
        {reactions(<div className="chat-bubble">
          {note.replyTo && <ReplyQuote reply={note.replyTo} name={name} onShow={onShowReplied?.(note.replyTo)} />}
          {note.files && <ChatFiles files={note.files} />}
          <div className="chat-text tc-plain"><SaidText text={note.text} /></div>
        </div>)}
        <div className="chat-under"><Swap key={state}>{state}</Swap></div>
      </div>
    </div>
  )
}

interface AnswerProps {
  tour: boolean
  run: RunRecord
  answer: string
  /** Every file the run's agents read or wrote, for names the answer gives from an agent's folder. */
  touched: readonly string[]
  /** The folder the answering agent works in, for a link to a file it made with a command. */
  folder: string | null
  streaming: boolean
  name: (id: string) => string
  hue: (id: string) => number
  /** A document answer is open in the pane beside the chat. */
  open: boolean
  /** A reply's quote asked to show this answer. */
  flash?: boolean
  onOpen: () => void
  /** An agent's own chat: every answer is to you, there being no team. */
  solo: boolean
  /** The answer with its reactions under it. */
  reactions: (said: ReactNode) => ReactNode
  children: ReactNode
}

function Outcome({ tries, fixFilled, onTryAgain, onDetails, ...answer }: AnswerProps & { tries: string | null; fixFilled: boolean; onTryAgain: () => void; onDetails: () => void }) {
  // The schedule tries again by itself: no stop to act on, only when.
  if (tries) return <Appearing className="chat-notice tc-tries" role="status"><span>{tries}</span></Appearing>
  if (answer.run.status === 'failed' || answer.run.status === 'cancelled') return <Stopped run={answer.run} name={answer.name} fixFilled={fixFilled} onTryAgain={onTryAgain} onDetails={onDetails} />
  if (!answer.answer.trim()) return null
  return <Answer {...answer} />
}

/** Where to fix a stop LoomWatch named: a plan's limit, used-up credit, a source not connected. A
    gold fill on the newest such stop (`filled`), a gold ring on any other. */
export function FixIt({ message, filled }: { message: string | null; filled: boolean }) {
  const action = problemAction(message)
  if (!action) return null
  const className = `btn ${filled ? 'btn-primary' : 'btn-ring'}`
  return action.external
    ? <a className={className} href={action.href} target="_blank" rel="noreferrer">{action.label}</a>
    : <a className={className} href={action.href}>{action.label}</a>
}

/** The work stopped: in plain words, with the way to try again. */
function Stopped({ run, name, fixFilled, onTryAgain, onDetails }: { run: RunRecord; name: (id: string) => string; fixFilled: boolean; onTryAgain: () => void; onDetails: () => void }) {
  if (run.status === 'failed') {
    return (
      <Appearing className="tc-stopped bad" role="status">
        <p><b><StatusGlyph status="failed" size={10} />The work stopped.</b> {run.error ? plainRunError(run.error.split('\n')[0], new Map(run.agentIds.map((id) => [id, { name: name(id) }]))) : run.errorCode === 'missing_canonical_response' ? `${name(run.responder)} finished without an answer.` : 'Its record says why.'}</p>
        <div className="tc-acts">
          <FixIt message={run.error} filled={fixFilled} />
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
function Answer({ tour, run, answer, touched, folder, streaming, name, hue, open, flash = false, onOpen, solo, reactions, children }: AnswerProps) {
  const appear = useAppear()
  // Names listed under a folder, or given from the agent's own folder, read as files in the sentence
  // too; copy and save keep the agent's words.
  const shown = useMemo(() => withFolderPaths(answer, touched, folder), [answer, touched, folder])
  const facts = useMemo(() => (isDocument(answer) ? describeDocument(answer) : null), [answer])
  const responder = run.responder
  return (
    <div className={`chat-msg tc-answer${appear ? ' tc-appear' : ''}${flash ? ' flash' : ''}`} data-tour={tour ? 'output' : undefined}>
      <span className="chat-gutter"><AgentFace id={responder}><AvatarFace id={responder} hue={hue(responder)} size={28} text={initials(name(responder))} /></AgentFace></span>
      <div className="chat-stack">
        <div className={`chat-meta hue-${hue(responder)}`}><span className="chat-name">{name(responder)}</span><span className="tc-to">{run.onlyAgent || solo ? 'to you' : "the team's answer"}</span><time>{clockTime(run.finishedAt)}</time></div>
        {reactions(facts ? (
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
        ))}
        {children}
      </div>
    </div>
  )
}

/**
 * The team on a piece of work as a thread on a loom: each agent a knot, the thread gold as far as
 * the work has come, and a bead in the gap after whoever has it now — green while it works, gold
 * while it waits on you. When the work passes on, the gold runs to the next agent and the bead
 * slides after it.
 */
function Weft({ workers, at, live, waiting, status, children }: { workers: readonly string[]; at: number; live: boolean; waiting: boolean; status: string; children: ReactNode }) {
  const many = workers.length > 1
  const fill = many ? Math.min(1, at / (workers.length - 1)) : 0
  return (
    <span className={`tc-weft${many ? '' : ' one'}${live ? ' live' : ''}${waiting ? ' waiting' : ''} st-${status}`} aria-hidden="true" style={{ '--weft-at': at, '--weft-fill': fill } as CSSProperties}>
      {many && <><i className="tc-weft-track" /><i className="tc-weft-fill" /></>}
      {children}
      {live && many && at < workers.length - 1 && <i className="tc-weft-bead" />}
    </span>
  )
}

/** An agent named on the piece's line: in its own colour, as its name is on its messages. */
function Named({ hue, children }: { hue: number; children: ReactNode }) {
  return <b className={`chat-name hue-${hue}`}>{children}</b>
}

/** How far along the thread the work has come: the agent that has it now, or the end once done. */
function weftAt(workers: readonly string[], run: RunRecord, live: boolean, waiting: RunRecord['waitingOn']): number {
  if (!live) return Math.max(0, workers.length - 1)
  const holder = waiting ? (waiting.kind === 'review_stop' ? waiting.handoverFrom ?? '' : waiting.node) : run.working?.[0] ?? ''
  const index = workers.indexOf(holder)
  return index >= 0 ? index : 0
}

/** What the talk line says, as a key: a change of who is working, or of how the work moved, slides the new words in. */
function talkKey(live: boolean, waiting: RunRecord['waitingOn'], asking: readonly string[], working: readonly string[], status: string, pass: Baton | null): string {
  if (!live) return 'done'
  if (waiting) return `waiting:${waiting.node}`
  if (asking.length > 0) return `asking:${asking.join(',')}`
  if (pass) return `pass:${pass.kind}:${pass.agent}:${pass.from ?? ''}`
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

/**
 * Who took the work up, and when: the agent the piece starts with, from its first recorded event,
 * or — before the events are read — from the run saying it works or finished well.
 */
function pickedUpBy(first: string | undefined, run: RunRecord, agents: readonly { id: string; firstTs: string }[]): AgentReaction[] {
  if (!first) return []
  const recorded = agents.find((agent) => agent.id === first)
  if (recorded) return [{ face: 'seen', by: first, at: recorded.firstTs }]
  if (run.working?.includes(first) || run.status === 'succeeded') return [{ face: 'seen', by: first, at: run.startedAt ?? run.createdAt }]
  return []
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
