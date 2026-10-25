import { ArrowDown, ChevronDown, ChevronRight, Play, Reply, RotateCcw, Search, X } from 'lucide-react'
import { Fragment, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { continueWithTeam, findInChat, sendChatMessage, startFromNote, stillAnswering, uploadChatFile, type ChatFile, type ChatItem, type ChatMessage, type ChatTarget, type Found, type FoundPassage, type FoundPiece, type NoteFailure, type ReplyTo } from '../../lib/chat/client'
import { carriesFiles, dropped, useChatAttachments } from '../../lib/chat/attachments'
import { FindScopeContext, showFoundWords, type FindTerm } from '../../lib/chat/findWords'
import { isDocument } from '../../lib/chat/document'
import { nameWithHelpers } from '../../lib/chat/helpers'
import { clockTime, dayKey, dayLabel, listNames } from '../../lib/chat/format'
import { destination, withMention, type ChatAgent } from '../../lib/chat/route'
import { replyOf } from '../../lib/chat/reply'
import { answerReply, askedPassages, partId, type AskedPassage } from '../../lib/files/passage'
import { FileReaderContext } from '../../lib/files/reader'
import { markSeen } from '../../lib/chat/seen'
import { targets, yoursOn, type Face, type Reaction, type ReactionAbout } from '../../lib/chat/reactions'
import { AppearContext, useAppear } from '../../lib/chat/appear'
import { FollowContext, type ChatFollow } from '../../lib/chat/follow'
import { useTeamChat, type PendingMessage } from '../../lib/chat/useTeamChat'
import { DaemonUnreachableError } from '../../lib/daemonFetch'
import { inAboutYou, tellAllAgents, undoLesson, undoTellAllAgents, type Lesson } from '../../lib/lessons/client'
import { failedAgent, plainRunError, problemAction } from '../../lib/runs/errors'
import { answerRun, newStartKey, RunApiError, STALE_TEAM_REVISION, TEAM_NEEDS_REVIEW, type RunRecord, type TeamReview } from '../../lib/runs/client'
import type { ReceiptLine } from '../../lib/story/receipt'
import type { AlwaysAllowed } from '../../lib/tools/allow'
import { AgentFacesContext, ChatMentionsContext, type AgentFaces, type AgentFacts, type ChatMentions } from '../../lib/chat/faces'
import { batonWords, sameBaton, type Baton } from '../../lib/chat/baton'
import { usePieceLine } from '../../lib/chat/pieceLine'
import { AgentFace } from './AgentFace'
import { AvatarFace } from '../agents/AvatarFace'
import { StatusGlyph } from '../ui/glyphs'
import { BatonFlight } from './BatonFlight'
import { BatonPill } from './BatonPill'
import { ChatFind } from './ChatFind'
import { SaidText } from './SaidText'
import { Appearing, Swap } from './Appearing'
import { ChatComposer, type OpenDecision } from './ChatComposer'
import { Reactions } from './Reactions'
import { Learned } from './Learned'
import { ReplyQuote } from './ReplyQuote'
import { ChatFiles } from './ChatFiles'
import { FixIt, WorkPiece, type TeamView } from './WorkPiece'
import { InlineMarkdown, Markdown } from '../ui/Markdown'
import { earlierTries, triedAgain, tryingAgain } from '../../lib/chat/tries'
import { fetchMoveStatus, movedLine } from '../../lib/team-file/moveOntoMyAgents'

/** Saving the team before work starts: the revision the run is pinned to, or why it could not. */
export type Prepared = { ok: true; revision: string | null } | { ok: false; error: string }

interface TeamChatProps {
  teamPath: string
  teamName: string
  agents: readonly ChatAgent[]
  team: TeamView
  steps: number
  /** An example first message for an empty chat, from what the team is for. */
  suggestion: string | null
  /** The routine's next time, when the team has one. */
  routine?: ReactNode
  /** The piece shown in the pane beside the chat. */
  detailsRunId: string | null
  /** The piece whose answer that pane shows, as a document, rather than its record. */
  answerRunId?: string | null
  /** A document answer's card was opened. */
  onOpenAnswer: (runId: string) => void
  /** Why nothing can be sent right now, when that is so. */
  blocked: string | null
  /** Save the team before work starts, as Run always has (TNG89 §1.4). */
  prepare: () => Promise<Prepared>
  onDetails: (runId: string) => void
  /** A team from outside LoomWatch starts nothing until you have seen what it runs (ADR 0048). */
  onTeamReview: (review: TeamReview, retry: () => void) => void
  onStale: () => void
  onAlwaysAllow?: (agentId: string, what: AlwaysAllowed) => void
  announce: (text: string) => void
  /** The newest piece of work in the chat, whenever it changes: what Details follows. */
  onNewest?: (runId: string | null) => void
  /** You started work from the chat: Details goes to it. */
  onStarted?: (runId: string) => void
  /** A message Details asked to show — its timeline's "Read the message" — in the piece it belongs to. */
  reveal?: { runId: string; id: string; at: number } | null
  /** A finding of an answer's review, opened in Details: its record, or the agent's work. */
  onOpenFinding: (runId: string, line: ReceiptLine) => void
  /** The newest piece's run as it changes, or null for none: an agent's chat shows its figure at work by it. */
  onNewestRun?: (run: RunRecord | null) => void
  /** Run team brought you here: the box starts with @team, so what you write starts the team. */
  startTeam?: boolean
  /** The box has taken `startTeam`, so coming back to the chat later does not take it again. */
  onStartTeamTaken?: () => void
  /**
   * A part of a file marked in the reader beside the chat (ADR 0077): the box takes it as a reply
   * to write about, or — with `words` — it is sent at once, to `agent` (the agent who made the file
   * unless another was chosen). A part that isn't words brings its `pictures` (ADR 0091), which go
   * with it: in the box as files, or sent with it. `at` tells one ask from the next.
   */
  ask?: { reply: ReplyTo; words?: string; agent?: string; pictures?: readonly File[]; at: number } | null
  /**
   * The parts of files asked about in this chat, the one in the box now, and the team's agents as
   * their cards show them (for the reader's bubbles), whenever they change.
   */
  onPassages?: (asked: AskedPassage[], asking: string | null, faces: AgentFacts[]) => void
  /**
   * A folder dropped on the chat, by its name (ADR 0082): a page can't learn where it is, so it is
   * found in the folder picker and added for the team rather than sent. Resolves with what to say
   * about it, or `null` when the picker was closed.
   */
  onConnectFolder?: (name: string) => Promise<string | null>
}

/** Sending one message: as a retry of a pending one, and as a reply to something said. */
type Send = (text: string, to: ChatTarget, now: boolean, retryOf?: string, replyTo?: ReplyTo | null, files?: readonly ChatFile[]) => Promise<boolean>

/** Within this of the bottom, the chat follows new messages. */
const FOLLOW_PX = 120
/** Room left under something revealed, so it does not sit against the message box. */
const REVEAL_MARGIN_PX = 16
/** Whether the list of who is on the team is folded, kept for this browser. */
const ROSTER_KEY = 'loomwatch.chatRoster'

/**
 * A team's chat (ADR 0051): the one place you work with the team. You write to it as you would to
 * people — @team to start everyone, @ a name for one agent, anything else a note — and the agents
 * work and answer here, with everything said before above it. Runs are still how work executes;
 * each piece of work here is one, and Details opens its full record.
 *
 * With `team.solo` it is one agent's own chat (its Chat tab): everything you write goes to that
 * agent, starting its work when it is free and joining its turn while it works, so there is no @.
 */
export function TeamChat({ teamPath, teamName, agents, team, steps, suggestion, routine, detailsRunId, answerRunId = null, onOpenAnswer, blocked, prepare, onDetails, onTeamReview, onStale, onAlwaysAllow, announce, onNewest, onStarted, reveal = null, onOpenFinding, onNewestRun, startTeam = false, onStartTeamTaken, ask = null, onPassages, onConnectFolder }: TeamChatProps) {
  const chat = useTeamChat(teamPath)
  // Pictures and files pasted or dropped in, kept as they are added (ADR 0082).
  const attachments = useChatAttachments(teamPath)
  const { add: addFiles, clear: clearFiles, remove: removeFile } = attachments
  // A drag of files from outside the page over the chat: drawn as the gold stitch round it. Set on
  // the way in and out only, never on every move, so nothing re-renders while it is dragged about.
  const [dropping, setDropping] = useState(false)
  const dragDepth = useRef(0)
  const takeFiles = useRef<(transfer: DataTransfer) => void>(() => {})
  // A file dropped anywhere else while the chat is open is ignored, rather than the browser opening
  // it in place of LoomWatch.
  useEffect(() => {
    const ignore = (event: DragEvent) => {
      // The chat's own handler took it first: it is a drop there.
      if (!carriesFiles(event.dataTransfer) || event.defaultPrevented) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
    }
    window.addEventListener('dragover', ignore)
    window.addEventListener('drop', ignore)
    return () => {
      window.removeEventListener('dragover', ignore)
      window.removeEventListener('drop', ignore)
    }
  }, [])
  // Something an agent learned from your feedback, taken back (ADR 0078): the chat reads again.
  // One that Tell all my agents moved to About you moves back to its agent.
  const undoLearned = useCallback(async (lesson: Lesson) => {
    const of = { teamPath, agent: lesson.agentId }
    await (inAboutYou(lesson) ? undoTellAllAgents(of, lesson.id) : undoLesson(of, lesson.id))
    chat.refresh()
  }, [teamPath, chat])
  // A lesson about you, moved to About you for every agent once you said yes.
  const tellAllLearned = useCallback(async (lesson: Lesson) => {
    await tellAllAgents({ teamPath, agent: lesson.agentId }, lesson.id)
    chat.refresh()
  }, [teamPath, chat])
  // Run team means start the team. Without an @, what is written is a note that starts nothing,
  // which is not what someone who pressed Run team expects, so the box it opens starts with @team.
  // Run team is on the workflow, where the chat is not open, so the chat always opens fresh for it.
  // One agent's own chat needs no @, and a box that cannot send yet (`blocked`) is not written in.
  const startsWithTeam = startTeam && !team.solo && !blocked
  const [draft, setDraft] = useState(() => (startsWithTeam ? '@team ' : ''))
  // What the message being written replies to, when Reply was pressed under something said.
  const [replyTo, setReplyTo] = useState<ReplyTo | null>(null)
  // Reply on what the team waits on you for takes the box back to answering it.
  const [answerAsked, setAnswerAsked] = useState(0)
  // What the chat shows when asked: a message Details asked for, or what a reply's quote points at.
  const [shown, setShown] = useState(reveal)
  const [seenReveal, setSeenReveal] = useState(reveal)
  if (reveal !== seenReveal) {
    setSeenReveal(reveal)
    setShown(reveal)
  }  // Once the first page has painted, what arrives is news and moves in (lib/chat/appear.ts).
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    if (!chat.loaded || settled || chat.loadingOlder) return
    const frame = requestAnimationFrame(() => setSettled(true))
    return () => cancelAnimationFrame(frame)
  }, [chat.loaded, settled, chat.loadingOlder])
  const search = useChatFind(teamPath)
  const startKeys = useRef(new Map<string, string>())
  const scroller = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const restore = useRef<number | null>(null)
  const runs = useMemo(() => new Map(chat.items.flatMap((item) => (item.kind === 'work' ? [[item.run.runId, item.run] as const] : []))), [chat.items])
  // A routine's tries at one job read as one piece, at its newest try (lib/chat/tries.ts).
  const shownItems = useMemo(() => {
    const folded = triedAgain(runs.values())
    return chat.items.filter((item) => item.kind !== 'work' || !folded.has(item.run.runId))
  }, [chat.items, runs])
  const continuedFrom = useMemo(() => new Set(chat.items.flatMap((item) => (item.kind === 'work' && item.run.followsRunId && !item.run.onlyAgent ? [item.run.followsRunId] : []))), [chat.items])

  // What the team is waiting on you for: the newest open review or question, which the box below
  // answers. If it is a review, its Approve is the screen's one gold fill; an older piece waiting too
  // has its Approve as a ring (DESIGN_LANGUAGE §8). With none known yet (a piece reads its own
  // fresher record), each Approve is filled, so a run waiting on you never shows no fill.
  const decision = useMemo<OpenDecision | null>(() => {
    for (const run of [...chat.live].sort((left, right) => right.createdAt.localeCompare(left.createdAt))) {
      const waiting = run.waitingOn
      if (!waiting) continue
      const from = waiting.kind === 'review_stop' ? waiting.handoverFrom ?? waiting.node : waiting.node
      return { runId: run.runId, node: waiting.node, kind: waiting.kind, from, fromName: team.names.get(from) ?? from }
    }
    return null
  }, [chat.live, team.names])
  // While nothing waits on you, the newest stop's way out is the screen's one gold fill.
  const fixFill = useMemo(() => filledFix(shownItems, decision), [shownItems, decision])

  // ---- scrolling -------------------------------------------------------------------------
  const newest = chat.items.at(-1)
  const lastKey = `${chat.items.length}:${newest ? JSON.stringify([newest.kind === 'work' ? [newest.run.status, newest.run.reply?.length, newest.notes.length, newest.run.waitingOn?.since] : newest.message.id]) : ''}:${chat.pending.length}`
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    if (restore.current !== null) {
      element.scrollTop += element.scrollHeight - restore.current
      restore.current = null
      return
    }
    if (atBottom.current) element.scrollTop = element.scrollHeight
    else setShowJump(true)
  }, [lastKey])
  // And keeps to it while what is there grows — the agents' talk read in, an answer streaming —
  // unless you are reading further up, or the growth is something you just opened yourself.
  const touched = useRef(0)
  useEffect(() => {
    const element = scroller.current
    if (!element || typeof ResizeObserver === 'undefined') return
    let height = element.scrollHeight
    const sizes = new ResizeObserver(() => {
      const grew = element.scrollHeight > height
      height = element.scrollHeight
      if (grew && atBottom.current && restore.current === null && performance.now() - touched.current > 600) element.scrollTop = element.scrollHeight
    })
    const watch = () => {
      sizes.disconnect()
      for (const child of element.children) sizes.observe(child)
    }
    watch()
    const children = new MutationObserver(watch)
    children.observe(element, { childList: true })
    return () => { sizes.disconnect(); children.disconnect() }
  }, [])
  const onScroll = () => {
    const element = scroller.current
    if (!element) return
    atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_PX
    if (atBottom.current) setShowJump(false)
    if (element.scrollTop < 60 && chat.more && !chat.loadingOlder) loadOlder()
  }
  const loadOlder = () => {
    // History read back is not news: it appears without motion.
    setSettled(false)
    restore.current = scroller.current?.scrollHeight ?? null
    void chat.loadOlder()
  }
  const jump = () => {
    const element = scroller.current
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
    atBottom.current = true
    setShowJump(false)
  }
  // A message not sent waits at the bottom of the chat, with Try again: shown from the reader there.
  useEffect(() => {
    if (shown?.id !== 'pending') return
    const frame = requestAnimationFrame(() => {
      scroller.current?.scrollTo?.({ top: scroller.current.scrollHeight, behavior: 'smooth' })
      atBottom.current = true
      setShowJump(false)
    })
    return () => cancelAnimationFrame(frame)
  }, [shown])
  // What waits on you comes into view as it arrives, even within a moment of your last click;
  // answering is following the work again (lib/chat/follow.ts).
  const follow = useMemo<ChatFollow>(() => ({
    pin: () => {
      atBottom.current = true
      setShowJump(false)
    },
    reveal: (target) => {
      const element = scroller.current
      if (!element || !atBottom.current || restore.current !== null) return
      const below = target.getBoundingClientRect().bottom + REVEAL_MARGIN_PX - element.getBoundingClientRect().bottom
      if (below > 0) element.scrollTop += below
    },
  }), [])

  // You have seen this chat up to its newest item while it is on screen.
  const newestAt = newest ? (newest.kind === 'work' ? newest.run.finishedAt ?? newest.run.createdAt : newest.message.createdAt) : null
  useEffect(() => {
    if (newestAt && chat.relativePath && !document.hidden) markSeen(chat.relativePath, newestAt)
  }, [chat.relativePath, newestAt])

  // An answer that arrives while you are here is announced once, so a screen reader hears it.
  const statuses = useRef(new Map<string, string>())
  useEffect(() => {
    for (const item of chat.items) {
      if (item.kind !== 'work') continue
      const before = statuses.current.get(item.run.runId)
      statuses.current.set(item.run.runId, item.run.status)
      if (before && before !== 'succeeded' && item.run.status === 'succeeded') announce(`${team.names.get(item.run.responder) ?? item.run.responder} answered.`)
    }
  }, [chat.items, announce, team.names])

  // ---- sending -----------------------------------------------------------------------------
  const live = chat.live
  // "Trust and run" sends again what the review held back; through a ref, so a callback can
  // name itself.
  const resend = useRef<Send>(async () => false)
  const restart = useRef<(message: ChatMessage) => Promise<void>>(async () => {})
  const send = useCallback<Send>(async (text, to, now, retryOf, replyTo = null, files = []) => {
    const where = destination(to, live, team.names, steps, now)
    const startsWork = where.route === 'team' || where.route === 'agent'
    let revision: string | null = null
    if (startsWork) {
      const prepared = await prepare()
      if (!prepared.ok) { announce(prepared.error); return false }
      revision = prepared.revision
    }
    if (retryOf) chat.dismissPending(retryOf)
    const localId = chat.beginSend(text, to, now, replyTo, files)
    const key = (retryOf && startKeys.current.get(retryOf)) || newStartKey()
    startKeys.current.set(localId, key)
    atBottom.current = true
    try {
      const result = await sendChatMessage({ teamPath, text, to, now, expectedRevision: revision, startKey: startsWork ? key : undefined, replyTo, files })
      chat.settleSend(localId, result)
      if ((result.route === 'team' || result.route === 'agent') && result.run) onStarted?.(result.run.runId)
      startKeys.current.delete(localId)
      // A message answered instead of started ("hi @team") says so itself, under it in the chat.
      if (result.route !== where.route && !result.message.answers) announce(routeChanged(result.route, team.names.get(result.message.agentId ?? '') ?? result.message.agentId ?? '', Boolean(team.solo)))
      return true
    } catch (caught) {
      if (caught instanceof RunApiError && caught.code === TEAM_NEEDS_REVIEW && caught.review) {
        chat.dismissPending(localId)
        // Held in the box meanwhile; once "Trust and run" sends it, the box lets it go.
        onTeamReview(caught.review, () => {
          void resend.current(text, to, now, undefined, replyTo, files).then((sent) => {
            if (!sent) return
            setDraft((current) => (current.trim() === text ? '' : current))
            if (files.length > 0) clearFiles()
            setReplyTo((current) => (current?.messageId === replyTo?.messageId ? null : current))
          })
        })
        return false
      }
      if (caught instanceof RunApiError && caught.code === STALE_TEAM_REVISION) onStale()
      chat.failSend(localId, caught instanceof DaemonUnreachableError ? caught.message : caught instanceof Error ? caught.message : String(caught))
      return true
    }
  }, [live, team.names, team.solo, steps, prepare, chat, teamPath, announce, onTeamReview, onStale, onStarted, clearFiles])

  useEffect(() => { resend.current = send }, [send])

  // What happened, such as to a dropped folder, said over the message box for a while.
  const [boxNote, setBoxNote] = useState<string | null>(null)
  useEffect(() => {
    if (!boxNote) return
    const timer = window.setTimeout(() => setBoxNote(null), 8000)
    return () => window.clearTimeout(timer)
  }, [boxNote])
  // The move onto My agents changed what an agent of this team runs (ADR 0094): said here each time
  // the chat opens, until it is let go or a message is sent.
  const [moved, setMoved] = useState<{ line: string; said: string } | null>(null)
  useEffect(() => {
    let live = true
    fetchMoveStatus().then((status) => {
      const key = Object.keys(status?.changed ?? {}).find((path) => path === teamPath || teamPath.endsWith(`/${path}`))
      if (!live || !status || !key) return
      const said = `loomwatch:moved-said:${key}`
      try {
        if (window.localStorage.getItem(said)) return
      } catch {
        // Nowhere to remember it was let go: it is said each time.
      }
      setMoved({ line: movedLine(status.changed[key]), said })
    }, () => {})
    return () => { live = false }
  }, [teamPath])
  const letMovedGo = useCallback(() => {
    setMoved((current) => {
      if (current) {
        try { window.localStorage.setItem(current.said, '1') } catch { /* said again next time */ }
      }
      return null
    })
  }, [])
  const connectFolder = useCallback(async (names: readonly string[]) => {
    if (names.length === 0) return
    if (!onConnectFolder) {
      const who = team.solo ? team.names.get(team.solo) ?? team.solo : null
      setBoxNote(who ? `A folder can’t go in a chat. Give it to ${who} in Build, under Folder.` : 'A folder can’t go in a chat. Give it to your agents in Build, under Folder.')
      return
    }
    const said = await onConnectFolder(names[0])
    if (said) setBoxNote(said)
  }, [onConnectFolder, team.solo, team.names])
  useEffect(() => {
    takeFiles.current = (transfer) => {
      const { files, folders } = dropped(transfer)
      if (files.length > 0) addFiles(files)
      void connectFolder(folders)
    }
  }, [addFiles, connectFolder])

  const answer = useCallback(async (open: OpenDecision, text: string) => {
    try {
      chat.applyRun(await answerRun(open.runId, open.node, text))
      return true
    } catch (caught) {
      announce(caught instanceof Error ? caught.message : String(caught))
      return false
    }
  }, [chat, announce])

  const tryAgain = useCallback((item: Extract<ChatItem, { kind: 'work' }>) => {
    const text = item.request?.text ?? item.run.prompt
    void send(text, item.run.onlyAgent ? { kind: 'agent', agent: item.run.onlyAgent } : { kind: 'team' }, false, undefined, item.request?.replyTo ?? null, item.request?.files ?? [])
  }, [send])

  const keepGoing = useCallback(async (runId: string) => {
    const prepared = await prepare()
    if (!prepared.ok) throw new Error(prepared.error)
    const started = await continueWithTeam(runId, prepared.revision)
    chat.applyRun(started.run)
    onStarted?.(started.run.runId)
    atBottom.current = true
  }, [prepare, chat, onStarted])

  const startNote = useCallback(async (message: ChatMessage) => {
    const prepared = await prepare()
    if (!prepared.ok) { announce(prepared.error); return }
    try {
      const started = await startFromNote(message.id, prepared.revision)
      chat.removeNote(message)
      chat.settleSend('', started)
      if (started.run) onStarted?.(started.run.runId)
      atBottom.current = true
    } catch (caught) {
      if (caught instanceof RunApiError && caught.code === TEAM_NEEDS_REVIEW && caught.review) {
        onTeamReview(caught.review, () => { void restart.current(message) })
        return
      }
      announce(caught instanceof Error ? caught.message : String(caught))
    }
  }, [prepare, chat, announce, onTeamReview, onStarted])

  useEffect(() => { restart.current = startNote }, [startNote])

  // ---- drawing -------------------------------------------------------------------------------
  const newestWork = chat.items.findLast((item): item is Extract<ChatItem, { kind: 'work' }> => item.kind === 'work')?.run ?? null
  const newestRun = newestWork?.runId ?? null
  useEffect(() => { if (chat.loaded) onNewest?.(newestRun) }, [chat.loaded, newestRun, onNewest])
  useEffect(() => { if (chat.loaded) onNewestRun?.(newestWork) }, [chat.loaded, newestWork, onNewestRun])
  const members = agents.filter((agent) => !agent.operator)
  const soloAgent = team.solo ? members.find((agent) => agent.id === team.solo) ?? null : null
  const workingNow = new Set(live.flatMap((run) => run.working ?? []))
  const waitingFor = decision?.from
  const unreachable = chat.error && /reach the LoomWatch server/i.test(chat.error)
  // An agent that asked you something, or asked your permission, is still in its turn, but it is
  // you it waits on.
  const asking = new Set(live.flatMap((run) => [
    ...(run.permissionRequests ?? []).map((request) => request.agent),
    // At the run's spool every agent at work waits; at an agent's own guard, that agent (ADR 0068).
    ...(run.spendStops ?? []).flatMap((stop) => (stop.agent ? [stop.agent] : run.working ?? [])),
  ]))
  const failed = failedNow(runs.values())
  const presence = members.map((agent) => ({ agent, state: (unreachable ? 'away' : waitingFor === agent.id || asking.has(agent.id) ? 'waiting' : workingNow.has(agent.id) ? 'working' : failed.has(agent.id) ? 'failed' : 'idle') as Presence }))
  // Each face can say who its agent is, and puts `@name` in the message box when clicked. A box
  // that opens with @team (`startsWithTeam`) takes the caret the same way.
  const [mentioned, setMentioned] = useState(() => (startsWithTeam ? 1 : 0))
  useEffect(() => {
    if (startTeam) onStartTeamTaken?.()
  }, [startTeam, onStartTeamTaken])
  const states = new Map(presence.map(({ agent, state }) => [agent.id, state]))
  // Who has the work right now (lib/chat/baton.ts). Each live piece says it on its own line and
  // reports it here; the header follows the newest piece with someone at work. While that piece's
  // line is on screen the header shows the faces alone; once the line is scrolled out of view it
  // flies up into the header and becomes a pill growing from the agent's face (lib/chat/pieceLine.ts).
  const [batons, setBatons] = useState<ReadonlyMap<string, Baton | null>>(() => new Map())
  const onBaton = useCallback((runId: string, next: Baton | null) => {
    setBatons((now) => (sameBaton(now.get(runId) ?? null, next) ? now : new Map(now).set(runId, next)))
  }, [])
  const held = unreachable ? null : heldBy(live, batons, new Set(members.map((agent) => agent.id)))
  const baton = held?.baton ?? null
  const batonText = baton ? batonWords(baton, (id) => members.find((agent) => agent.id === id)?.name || id) : null
  const holding = baton && batonText ? { agent: baton.agent, words: batonText.pill, hue: team.hues.get(baton.agent) ?? 1, waiting: baton.kind === 'you' } : null
  const line = usePieceLine(scroller, held?.runId ?? null, holding)
  const pill = line.inView === false ? baton : null
  // The line is on its way up: whatever the header now shows waits hidden until it lands.
  const landing = line.flight?.way === 'up'
  const faces: AgentFaces = {
    facts: (id) => {
      const agent = members.find((member) => member.id === id)
      // One agent's own chat has its whole workbench beside it, and no one to @: no card.
      if (!agent || soloAgent) return null
      const config = team.configs?.get(id)
      const state = states.get(id) ?? 'idle'
      const capabilities = config?.capabilities ?? []
      const step = team.order.indexOf(id)
      return {
        id,
        name: agent.name || id,
        hue: team.hues.get(id) ?? 1,
        state,
        stateWords: STATE_WORDS[state],
        model: team.models?.get(id) ?? (config?.model?.trim() || null),
        role: config?.role?.trim() || null,
        step: step >= 0 && team.order.length > 1 ? { at: step + 1, of: team.order.length } : null,
        skills: capabilities.filter((capability) => capability.kind === 'skill').length,
        tools: capabilities.filter((capability) => capability.kind === 'tool').length,
        knowledge: capabilities.filter((capability) => capability.kind === 'knowledge').length,
      }
    },
    mention: (id) => {
      const agent = members.find((member) => member.id === id)
      if (!agent) return
      setDraft((text) => withMention(text, agent, agents))
      setMentioned((count) => count + 1)
    },
  }
  // An @mention in a message shows as its agent's chip (SaidText); in one agent's own chat an @ goes nowhere.
  const mentions = useMemo<ChatMentions | null>(() => (team.solo ? null : { agents, hue: (id) => team.hues.get(id) ?? 1 }), [agents, team.hues, team.solo])
  // Reply under something said: the box takes it as the message being answered, addressed with
  // the @ of whoever said it (or `to`, a teammate asked about a part of a file instead), so it goes
  // to that agent as any @ does (ADR 0051).
  const startReply = (reply: ReplyTo, to?: string) => {
    const answers = decision !== null && reply.runId === decision.runId && reply.from === decision.from
      && (decision.kind === 'question' ? reply.kind === 'question' && reply.to === null : reply.kind === 'handover')
    if (answers) {
      // What the team waits on you for is answered in the box already: Reply goes back to it.
      setReplyTo(null)
      setAnswerAsked((count) => count + 1)
      return
    }
    setReplyTo(replyOf(reply))
    const author = members.find((agent) => agent.id === (to ?? reply.from))
    if (author && !soloAgent) setDraft((text) => withMention(text, author, agents))
    setMentioned((count) => count + 1)
  }
  // A part marked in the reader: written about in the box, as a reply is, or sent at once with
  // the words its button says ("Explain"), to the agent it is asked of. That agent answers it, or
  // asks the teammate whose job it is (ADR 0077). A box that cannot send shows why with the part
  // in it.
  const asked = useRef<number | null>(null)
  // The pictures a part that isn't words put in the box (ADR 0091), by the quote they came with:
  // letting go of the quote lets go of them.
  const partFiles = useRef<{ messageId: string; ids: string[] } | null>(null)
  useEffect(() => {
    const brought = partFiles.current
    if (!brought || replyTo?.messageId === brought.messageId) return
    for (const id of brought.ids) removeFile(id)
    partFiles.current = null
  }, [replyTo, removeFile])
  const takeAsk = useRef<(next: NonNullable<typeof ask>) => void>(() => {})
  useEffect(() => {
    takeAsk.current = (next) => {
      const author = members.find((agent) => agent.id === (next.agent ?? next.reply.from))
      const pictures = next.pictures ?? []
      // Written about in the box: the part's pictures wait in it with the quote, as files you added
      // do, and go with the quote when it is replaced or let go of.
      const inTheBox = (to?: string) => {
        startReply(next.reply, to)
        for (const id of partFiles.current?.ids ?? []) removeFile(id)
        partFiles.current = pictures.length > 0 ? { messageId: next.reply.messageId, ids: addFiles([...pictures]) } : null
      }
      if (!next.words || blocked || !author) { inTheBox(author?.id); return }
      const text = soloAgent ? next.words : withMention(next.words, author, agents)
      const to = { kind: 'agent', agent: author.id } as const
      if (pictures.length === 0) { void send(text, to, false, undefined, replyOf(next.reply)); return }
      // Sent at once with its pictures, kept first; a picture that can't be kept leaves the question
      // in the box, which says why and sends it from there.
      void Promise.all(pictures.map((picture) => uploadChatFile(teamPath, picture, picture.name)))
        .then((kept) => send(text, to, false, undefined, replyOf(next.reply), kept), () => { inTheBox(author.id); setDraft(text) })
    }
  })
  useEffect(() => {
    if (!ask || asked.current === ask.at) return
    asked.current = ask.at
    takeAsk.current(ask)
  }, [ask])
  // The parts of files asked about here, for the reader to light; compared by what they say, so a
  // page of the chat read again changes nothing.
  const passagesSaid = useMemo(() => JSON.stringify(askedPassages(chat.items, chat.pending)), [chat.items, chat.pending])
  const askingNow = replyTo?.kind === 'passage' ? partId(replyTo) : null
  const facesSaid = JSON.stringify(members.flatMap((member) => faces.facts(member.id) ?? []))
  useEffect(() => {
    onPassages?.(JSON.parse(passagesSaid) as AskedPassage[], askingNow, JSON.parse(facesSaid) as AgentFacts[])
  }, [passagesSaid, askingNow, facesSaid, onPassages])
  const address = (id: string) => {
    const agent = members.find((member) => member.id === id)
    if (!agent) return
    setDraft((text) => withMention(text, agent, agents))
    setMentioned((count) => count + 1)
  }
  // A reply's quote shows what it replied to, when that piece is in the chat; a part of a file
  // opens the file in the reader beside the chat, where the screen has one (ADR 0077).
  const readHere = useContext(FileReaderContext)
  const showReplied = (reply: ReplyTo) => (reply.kind === 'passage'
    ? (reply.file && readHere ? () => readHere({ path: reply.file as string, runId: reply.runId, from: reply.from }) : undefined)
    : reply.runId && runs.has(reply.runId)
      ? () => setShown({ runId: reply.runId as string, id: reply.messageId, at: Date.now() })
      // An agent's own answer to your message (`note:<id>`): your message, with the answers under it.
      : !reply.runId && chat.items.some((item) => item.kind === 'note' && `note:${item.message.id}` === reply.messageId)
        ? () => setShown({ runId: '', id: reply.messageId, at: Date.now() })
        : undefined)
  const name = (id: string) => nameWithHelpers(team.names, id) ?? id
  // A found line opened (ADR 0081): the chat goes back to its piece, reading earlier pages until it
  // is there, and shows the line in it with the words lit.
  const [noteShown, setNoteShown] = useState<{ id: string; at: number } | null>(null)
  // A note shown from outside the chat (`note:<id>`: the answers under it, from the reader), or by a search, whichever was last.
  const revealedNote = shown?.id.startsWith('note:') ? { id: shown.id.slice('note:'.length), at: shown.at } : null
  const noteFlash = revealedNote && (!noteShown || revealedNote.at > noteShown.at) ? revealedNote : noteShown
  const [opening, setOpening] = useState<{ piece: FoundPiece; passage: FoundPassage | null } | null>(null)
  const [landingMissed, setLandingMissed] = useState(false)
  const openFound = (piece: FoundPiece, passage: FoundPassage | null) => {
    search.land(search.found?.terms ?? [])
    setLandingMissed(false)
    setOpening({ piece, passage })
  }
  useEffect(() => {
    if (!opening) return
    const here = chat.items.find((item) => (item.kind === 'work' ? item.run.runId : item.message.id) === opening.piece.id)
    if (!here) {
      if (chat.loadingOlder) return
      if (chat.more) { loadOlder(); return }
      setOpening(null)
      setLandingMissed(true)
      return
    }
    setOpening(null)
    const at = Date.now()
    if (here.kind === 'note') { setNoteShown({ id: here.message.id, at }); return }
    // A long answer is read beside the chat: it opens there, with the words lit in it too.
    const target = opening.passage?.target ?? 'request'
    if (target === 'answer' && here.run.reply && isDocument(here.run.reply) && answerRunId !== here.run.runId) onOpenAnswer(here.run.runId)
    setShown({ runId: here.run.runId, id: revealId(here.run.runId, target), at })
    // `loadOlder` and `onOpenAnswer` are read as they are now; what moves the landing on is the chat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opening, chat.items, chat.more, chat.loadingOlder, answerRunId])
  // The words light wherever the chat or the answer beside it shows them, until the search closes.
  useEffect(() => {
    showFoundWords(search.lit)
    return () => showFoundWords(null)
  }, [search.lit])
  // What matches is read from the top, wherever the chat was scrolled.
  const foundKey = search.showing ? JSON.stringify(search.found?.pieces.map((piece) => piece.id) ?? []) : null
  useLayoutEffect(() => {
    if (foundKey === null || !scroller.current) return
    // Not following the newest message while what matches is read: it would pull the list down.
    atBottom.current = false
    scroller.current.scrollTop = 0
  }, [foundKey])
  // Closing the search from what matches goes back to the newest message, as the chat opens;
  // closing it at a message it opened stays there, for reading it or replying to it.
  const searching = search.open
  const wasLanded = useRef(false)
  useEffect(() => {
    if (search.open) wasLanded.current = search.landed
  })
  useLayoutEffect(() => {
    if (searching || !scroller.current || wasLanded.current) return
    atBottom.current = true
    scroller.current.scrollTop = scroller.current.scrollHeight
  }, [searching])
  const [rosterOpen, setRosterOpen] = useState(readRosterOpen)
  const rosterId = useId()
  const toggleRoster = () => {
    const next = !rosterOpen
    setRosterOpen(next)
    try {
      window.localStorage.setItem(ROSTER_KEY, next ? 'open' : 'folded')
    } catch {
      // Not kept; the list stays as it is until the page is closed.
    }
  }

  return (
    <AppearContext.Provider value={settled && !search.showing}>
    <FollowContext.Provider value={follow}>
    <AgentFacesContext.Provider value={faces}>
    <ChatMentionsContext.Provider value={mentions}>
    <section className={`tc${dropping ? ' dropping' : ''}`} aria-label={`${teamName} chat`} data-tour="chat" data-newest-run={newestRun ?? undefined}
      onDragEnter={(event) => {
        if (!carriesFiles(event.dataTransfer) || blocked) return
        event.preventDefault()
        dragDepth.current += 1
        if (dragDepth.current === 1) setDropping(true)
      }}
      onDragOver={(event) => {
        if (!carriesFiles(event.dataTransfer) || blocked) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        if (!carriesFiles(event.dataTransfer)) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDropping(false)
      }}
      onDrop={(event) => {
        if (!carriesFiles(event.dataTransfer)) return
        event.preventDefault()
        dragDepth.current = 0
        setDropping(false)
        if (!blocked) takeFiles.current(event.dataTransfer)
      }}>
      <header className={`tc-head${rosterOpen && !soloAgent ? '' : ' folded'}${soloAgent ? ' solo' : ''}`}>
        {soloAgent ? (
          // One agent's own chat: its face, its name and what it is doing, and nothing to fold.
          <div className="tc-title folded">
            <h2 className={`tc-member ${states.get(soloAgent.id) ?? 'idle'}`} aria-label={`${soloAgent.name || soloAgent.id}, ${STATE_WORDS[states.get(soloAgent.id) ?? 'idle']}`}>
              <span className="tc-face-row">
                <AvatarFace id={soloAgent.id} hue={team.hues.get(soloAgent.id) ?? 1} size={26} fontSize={10} text={initialsOf(soloAgent.name || soloAgent.id)} />
                <span className="tc-roster-name">{soloAgent.name || soloAgent.id}</span>
              </span>
              <Swap key={states.get(soloAgent.id) ?? 'idle'}><em>{STATE_WORDS[states.get(soloAgent.id) ?? 'idle']}</em></Swap>
            </h2>
          </div>
        ) : (
        <div className={`tc-title${rosterOpen ? '' : ' folded'}`}>
          <h2>
            <button type="button" className="tc-roster-toggle" aria-expanded={rosterOpen} aria-controls={rosterId} onClick={toggleRoster} title={rosterOpen ? 'Fold the list of who is on the team' : 'Show who is on the team'}>
              {rosterOpen ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
              <span className="tc-roster-name">{teamName}</span>
            </button>
          </h2>
          {/* Folded, the team reads as one line: its faces with their status, and what they are doing. */}
          {!rosterOpen && members.length > 0 && (
            <div className="tc-roster-summary">
              <span className={`tc-faces${pill ? ' has-baton' : ''}`}>
                {presence.map(({ agent, state }) => {
                  const holds = pill?.agent === agent.id ? batonText : null
                  const hue = team.hues.get(agent.id) ?? 1
                  return (
                    <span key={agent.id} className={`tc-member ${state}${holds ? ' holds' : ''}`}>
                      <AgentFace id={agent.id} doing={holds?.sentence}>
                        <AvatarFace id={agent.id} hue={hue} size={20} fontSize={8} text={initialsOf(agent.name || agent.id)} />
                        <BatonPill words={holds?.pill ?? null} hue={hue} waiting={pill?.kind === 'you'} target={agent.id} landing={landing && holds !== null} />
                      </AgentFace>
                    </span>
                  )
                })}
              </span>
              {/* While work is under way the pill says who has it — and between two agents, nothing
                  flashes "ready" — so the count comes back only once the work is done. */}
              {!baton && live.length === 0 && (
                <button type="button" className="tc-roster-more" onClick={toggleRoster} aria-label={`${rosterSummary(presence)}. Show who is on the team`}>
                  <Swap key={rosterSummary(presence)} className="tc-roster-words">{rosterSummary(presence)}</Swap>
                </button>
              )}
            </div>
          )}
          <ul id={rosterId} className="tc-members" aria-label="Who is on the team" hidden={!rosterOpen}>
            {presence.map(({ agent, state }) => {
              const holds = pill?.agent === agent.id ? batonText : null
              const words = holds?.row ?? STATE_WORDS[state]
              return (
                <li key={agent.id} className={`tc-member ${state}${holds ? ' holds' : ''}`}>
                  <AgentFace id={agent.id} className="tc-face-row">
                    <AvatarFace id={agent.id} hue={team.hues.get(agent.id) ?? 1} size={24} fontSize={9} text={initialsOf(agent.name || agent.id)} />
                    <span>{agent.name || agent.id}</span>
                  </AgentFace>
                  <Swap key={words}><em className={landing && holds ? 'landing' : undefined} data-baton-target={holds ? agent.id : undefined}>{words}</em></Swap>
                </li>
              )
            })}
          </ul>
        </div>
        )}
        <div className="tc-head-acts">
          {search.open ? (
            <label className="tc-search">
              <Search size={13} aria-hidden="true" />
              <input
                autoFocus
                value={search.text}
                onChange={(event) => search.setText(event.target.value)}
                onFocus={search.back}
                onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); search.close() } }}
                placeholder="Find in this chat"
                aria-label="Find in this chat"
              />
              <button type="button" className="tc-link" onClick={search.close} aria-label="Close find" title="Close find"><X size={13} aria-hidden="true" /></button>
            </label>
          ) : (
            <button type="button" className="tc-link" onClick={() => search.setOpen(true)} aria-label="Find in this chat" title="Find in this chat"><Search size={14} aria-hidden="true" /></button>
          )}
          {routine && <div className="tc-routine">{routine}</div>}
        </div>
      </header>

      <div className="tc-scroll" ref={scroller} onScroll={onScroll} onPointerDown={() => { touched.current = performance.now() }} onKeyDown={() => { touched.current = performance.now() }}>
        {chat.more && !search.showing && (
          <div className="tc-older">
            <button type="button" className="btn" disabled={chat.loadingOlder} onClick={loadOlder}>{chat.loadingOlder ? 'Loading earlier work…' : 'Show earlier work'}</button>
          </div>
        )}
        {!chat.loaded && <p className="tc-loading" role="status">Loading the chat…</p>}
        {chat.loaded && chat.items.length === 0 && chat.pending.length === 0 && !chat.error && !search.showing && (
          <div className="tc-empty">
            <SewnMark />
            {soloAgent ? <>
              <h3>Talk to {soloAgent.name || soloAgent.id}</h3>
              <p>Ask it for real work, the kind you would hand it. It works on it here, as it is on screen, and reads what was said before each time. Nothing here changes a team.</p>
            </> : <>
              <h3>Talk to {teamName}</h3>
              <p>Write <b>@team</b> and what you need to start the whole team, or <b>@</b> a name to ask one agent. Anything without an @ is a note the team reads the next time it works.</p>
            </>}
            {suggestion && (
              <button type="button" className="btn tc-suggest" onClick={() => setDraft(soloAgent ? suggestion : `@team ${suggestion}`)}>
                <Play size={13} aria-hidden="true" />{soloAgent ? '' : '@team '}<InlineMarkdown clickable={false}>{suggestion}</InlineMarkdown>
              </button>
            )}
          </div>
        )}
        {search.showing && (
          <ChatFind found={search.found} loading={search.loading} failed={search.failed} tooShort={search.tooShort} most={FIND_MOST} name={name} face={(id) => <AvatarFace id={id} hue={team.hues.get(id) ?? 1} size={20} fontSize={8} text={initialsOf(name(id))} />} onOpen={openFound} onRetry={search.retry} />
        )}
        {search.landed && (
          <div className="tc-find-back">
            <button type="button" className="tc-link" onClick={search.back}>← Back to the list</button>
            {landingMissed && <span role="status">That message is no longer in this chat.</span>}
          </div>
        )}
        <FindScopeContext.Provider value>
        <ol className="tc-log" role="log" aria-label="Messages" hidden={search.showing}>
          {shownItems.map((item, index, list) => {
            const at = item.kind === 'work' ? item.run.createdAt : item.message.createdAt
            const previous = list[index - 1]
            const newDay = !previous || dayKey(previous.kind === 'work' ? previous.run.createdAt : previous.message.createdAt) !== dayKey(at)
            return (
              <Fragment key={item.kind === 'work' ? item.run.runId : item.message.id}>
                {newDay && <li className="tc-day" aria-hidden="true"><span>{dayLabel(at)}</span></li>}
                {item.kind === 'work'
                  ? <WorkPiece item={item} newest={item.run.runId === newestRun} approveFilled={!decision || decision.runId === item.run.runId} fixFilled={fixFill === item.run.runId} reveal={shown?.runId === item.run.runId ? shown : null} followed={item.run.followsRunId ? runs.get(item.run.followsRunId) ?? null : null} earlier={earlierTries(item.run, runs)} continuedFrom={continuedFrom.has(item.run.runId)} team={team} draft={draft}
                      detailsOpen={detailsRunId === item.run.runId} answerOpen={answerRunId === item.run.runId} onDetails={onDetails} onOpenAnswer={onOpenAnswer} onRun={chat.applyRun} onBaton={onBaton} onLine={line.onLine} onTryAgain={tryAgain} onContinue={keepGoing}
                      onDecided={() => setDraft('')} onAlwaysAllow={onAlwaysAllow} onOpenFinding={onOpenFinding} onReply={startReply} onShowReplied={showReplied} onReact={chat.react} onUndoLesson={undoLearned} onTellAllLesson={tellAllLearned} />
                  : <TeamNote message={item.message} reactions={item.reactions} lessons={item.lessons} fixFill={fixFill} name={name} hue={(id) => team.hues.get(id) ?? 1} flash={noteFlash?.id === item.message.id ? noteFlash.at : null} onReply={startReply} onShowReplied={showReplied} onStart={() => void startNote(item.message)} onReact={chat.react} onUndoLesson={undoLearned} onTellAllLesson={tellAllLearned} />}
              </Fragment>
            )
          })}
          {chat.pending.map((message) => (
            <Pending key={message.localId} message={message} name={name} onRetry={() => void send(message.text, message.to, message.now, message.localId, message.replyTo, message.files)} onEdit={() => { chat.dismissPending(message.localId); setDraft(message.text); setReplyTo(message.replyTo); attachments.restore(message.files) }} onDismiss={() => chat.dismissPending(message.localId)} />
          ))}
        </ol>
        </FindScopeContext.Provider>
        {chat.error && chat.loaded && (
          <div className="tc-error" role="alert">
            <p>{chat.error}</p>
            <button type="button" className="btn" onClick={chat.refresh}><RotateCcw size={13} aria-hidden="true" />Try again</button>
          </div>
        )}
      </div>
      {showJump && <button type="button" className="tc-jump btn" onClick={jump}><ArrowDown size={14} aria-hidden="true" />Newest</button>}

      <ChatComposer
        agents={agents}
        names={team.names}
        steps={steps}
        live={live}
        decision={decision}
        disabled={blocked}
        value={draft}
        onChange={setDraft}
        onSend={async (text, to, now) => {
          // Out of the box with the words and the files, and back with them if the message was held.
          const reply = replyTo
          const files = attachments.kept
          setReplyTo(null)
          attachments.clear()
          const ok = await send(text, to, now, undefined, reply, files)
          if (ok) letMovedGo()
          if (!ok && reply) setReplyTo((current) => current ?? reply)
          if (!ok && files.length > 0) attachments.restore(files)
          return ok
        }}
        attachments={attachments}
        notice={boxNote ?? moved?.line ?? null}
        onDismissNotice={boxNote ? undefined : letMovedGo}
        onAnswer={answer}
        mentioned={mentioned}
        solo={soloAgent}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        onAddress={address}
        answerAsked={answerAsked}
      />
      {line.flight && <BatonFlight key={line.flight.id} flight={line.flight} holding={holding} onDone={line.done} />}
    </section>
    </ChatMentionsContext.Provider>
    </AgentFacesContext.Provider>
    </FollowContext.Provider>
    </AppearContext.Provider>
  )
}

/** LoomWatch's mark, sewn on when an empty chat opens: the stitch runs round the tile, then the face looks up. */
function SewnMark() {
  // The mask reveals the dashed stitch along its own path, so it reads as being sewn rather than fading in.
  const thread = `tc-sewn-${useId().replace(/[^\w-]/g, '')}`
  return (
    <svg className="tc-sewn" width="56" height="56" viewBox="0 0 512 512" aria-hidden="true">
      <mask id={thread}><path className="tc-sewn-run" pathLength={1} d="M256 44H382A86 86 0 0 1 468 130V382A86 86 0 0 1 382 468H130A86 86 0 0 1 44 382V130A86 86 0 0 1 130 44Z" fill="none" stroke="#fff" strokeWidth="40" /></mask>
      <rect width="512" height="512" rx="112" fill="#08080A" />
      <path mask={`url(#${thread})`} d="M256 44H382A86 86 0 0 1 468 130V382A86 86 0 0 1 382 468H130A86 86 0 0 1 44 382V130A86 86 0 0 1 130 44Z" fill="none" stroke="#D8A93C" strokeWidth="10" strokeLinecap="round" strokeDasharray="16.26 22.45" strokeDashoffset="8.13" />
      <g className="tc-sewn-face">
        <rect x="170" y="170" width="52" height="112" rx="26" fill="#F5F3EE" />
        <rect x="290" y="170" width="52" height="112" rx="26" fill="#F5F3EE" />
        <path d="M230 330Q256 352 282 330" fill="none" stroke="#E9C46A" strokeWidth="28" strokeLinecap="round" />
      </g>
    </svg>
  )
}

// The words the chat uses for work everywhere: ready to take it, at it, waiting on you, or stopped
// by an error. Each face glows its state's colour (team-chat.css).
const STATE_WORDS = { working: 'working', waiting: 'waiting for you', idle: 'ready', failed: 'failed', away: 'offline' } as const
type Presence = keyof typeof STATE_WORDS

/** The agents whose newest piece of work stopped at them with an error, until they work again. */
function failedNow(runs: Iterable<RunRecord>): Set<string> {
  const newest = new Map<string, RunRecord>()
  for (const run of runs) {
    for (const id of run.onlyAgent ? [run.onlyAgent] : run.agentIds) {
      const seen = newest.get(id)
      if (!seen || seen.createdAt < run.createdAt) newest.set(id, run)
    }
  }
  return new Set([...newest].filter(([id, run]) => failedAgent(run) === id).map(([id]) => id))
}

/** Who has the work in the newest live piece that has someone at it, as that piece said. */
function heldBy(live: readonly RunRecord[], batons: ReadonlyMap<string, Baton | null>, members: ReadonlySet<string>) {
  for (const run of [...live].sort((left, right) => right.createdAt.localeCompare(left.createdAt))) {
    const baton = batons.get(run.runId)
    if (baton && members.has(baton.agent)) return { runId: run.runId, baton }
  }
  return null
}

/** "1 working · 4 ready": the folded team, busiest first. */
function rosterSummary(presence: readonly { state: Presence }[]): string {
  const order: Presence[] = ['waiting', 'failed', 'working', 'idle', 'away']
  return order
    .map((state) => [state, presence.filter((member) => member.state === state).length] as const)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${count} ${STATE_WORDS[state]}`)
    .join(' · ')
}

/** Open unless you folded it in this browser. */
function readRosterOpen(): boolean {
  try {
    return window.localStorage.getItem(ROSTER_KEY) !== 'folded'
  } catch {
    return true
  }
}

/**
 * Finding words in the team's whole chat (ADR 0081): the daemon matches them in every request,
 * answer, note and line of the agents' talk, in any order and any form, with or without accents.
 * What matches shows in place of the chat; opening a line goes back to the chat at that message,
 * with the words lit until the search is closed.
 */
function useChatFind(teamPath: string) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  // What was found is kept with the words it answers, so it never shows for other words.
  const [found, setFound] = useState<{ words: string; found: Found } | null>(null)
  // The words whose search failed: said as a failure, never as nothing found.
  const [failed, setFailed] = useState<string | null>(null)
  const [retries, setRetries] = useState(0)
  // A line opened: the chat is shown at it, with these words lit.
  const [landed, setLanded] = useState<readonly FindTerm[] | null>(null)
  const words = text.trim()
  const searching = open && words.length >= 2
  useEffect(() => {
    if (!searching) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void findInChat(teamPath, text, controller.signal)
        .then((result) => { setFailed(null); setFound({ words, found: result }) })
        .catch(() => { if (!controller.signal.aborted) setFailed(words) })
    }, 250)
    return () => { controller.abort(); window.clearTimeout(timer) }
    // `text` is read for whether the last word is still being typed; `words` decides when to ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching, words, teamPath, retries])
  // While new words are asked about, what the last ones found stays, so the list doesn't blink.
  const current = searching ? found?.found ?? null : null
  return {
    open,
    setOpen,
    text,
    setText: (next: string) => { setText(next); setLanded(null) },
    found: current,
    loading: searching && found?.words !== words && failed !== words,
    failed: searching && failed === words,
    tooShort: open && words.length === 1,
    retry: () => setRetries((count) => count + 1),
    showing: (searching || (open && words.length === 1)) && landed === null,
    landed: landed !== null,
    lit: landed,
    land: (terms: readonly FindTerm[]) => setLanded(terms),
    back: () => setLanded(null),
    close: () => { setOpen(false); setText(''); setLanded(null); setFound(null); setFailed(null) },
  }
}

/** The most pieces a search gives (`FIND_PIECES` in chat.rs). */
const FIND_MOST = 30

/** What a found line is shown as in its piece: the id `WorkPiece`'s `reveal` takes. */
function revealId(runId: string, target: string): string {
  if (target === 'answer') return `answer:${runId}`
  if (target === 'request') return `request:${runId}`
  if (target.startsWith('talk:')) return target.slice('talk:'.length)
  return target
}

/**
 * A note to the whole team: it starts nothing, and the next work reads it. An @ message that needed
 * no workflow ("hi @team") is drawn as you sent it, with each agent's own answer under it, and the
 * ones still writing typing, in place of the work it would have started. You can react to the note
 * and to each answer, as to anything said in the chat; the faces are kept on the note. Reply under an
 * answer writes back to the agent that gave it, with the answer quoted (ADR 0051), or about the same
 * part of a file when that is what your message asked about (ADR 0077).
 */
function TeamNote({ message, reactions, lessons, fixFill = null, name, hue, flash = null, onReply, onShowReplied, onStart, onReact, onUndoLesson, onTellAllLesson }: { message: ChatMessage; reactions?: readonly Reaction[]; lessons?: readonly Lesson[]; fixFill?: string | null; name: (id: string) => string; hue: (id: string) => number; flash?: number | null; onReply?: (reply: ReplyTo, to?: string) => void; onShowReplied: (reply: ReplyTo) => (() => void) | undefined; onStart: () => void; onReact?: (anchor: string, target: string, face: Face | null, about?: ReactionAbout) => Promise<void>; onUndoLesson?: (lesson: Lesson) => Promise<void>; onTellAllLesson?: (lesson: Lesson) => Promise<void> }) {
  const [starting, setStarting] = useState(false)
  const appear = useAppear()
  // Found by a search and opened (ADR 0081): it comes into view, ringed for a moment.
  const shown = useRef<HTMLLIElement>(null)
  const [seenFlash, setSeenFlash] = useState(flash)
  const [flashing, setFlashing] = useState<number | null>(null)
  if (flash !== seenFlash) {
    setSeenFlash(flash)
    setFlashing(flash)
  }
  useEffect(() => {
    if (flashing === null) return
    shown.current?.scrollIntoView?.({ block: 'center' })
    const timer = window.setTimeout(() => setFlashing(null), 1800)
    return () => window.clearTimeout(timer)
  }, [flashing])
  const lit = flashing !== null ? ' flash' : ''
  const answers = message.answers
  const reactOn = (target: string, about: string, mine = false) => (said: ReactNode) => (
    <Reactions yours={yoursOn(reactions, target)} about={about} name={name} hue={hue} mine={mine} onReact={onReact && ((face) => onReact(message.id, target, face))}>{said}</Reactions>
  )
  const yours = reactOn(targets.note(message.id), answers ? 'your message' : 'your note', true)
  if (answers) {
    const to = message.agentId ? name(message.agentId) : 'the team'
    const waiting = stillAnswering(message)
    const face = (id: string) => <span className="chat-gutter"><AgentFace id={id}><AvatarFace id={id} hue={hue(id)} size={28} text={initialsOf(name(id))} /></AgentFace></span>
    return (
      <>
        <li ref={shown} className={`chat-msg mine tc-answered-note${appear ? ' tc-appear' : ''}${lit}`}>
          <div className="chat-stack">
            <div className="chat-meta"><span className="tc-to">You → {to}</span><time>{clockTime(message.createdAt)}</time></div>
            {yours(<div className="chat-bubble">
              {message.replyTo && <ReplyQuote reply={message.replyTo} name={name} onShow={onShowReplied(message.replyTo)} />}
              {message.files && <ChatFiles files={message.files} />}
              <div className="chat-text"><SaidText text={message.text} /></div>
            </div>)}
          </div>
        </li>
        {answers.said.map((said) => (
          <li key={`said-${said.from}`} className="chat-msg tc-answer tc-said-back tc-appear">
            {face(said.from)}
            <div className="chat-stack">
              <div className={`chat-meta hue-${hue(said.from)}`}><span className="chat-name">{name(said.from)}</span><span className="tc-to">to you</span><time>{clockTime(said.at)}</time></div>
              {reactOn(targets.reply(said.from), `${name(said.from)}'s answer`)(<div className="chat-bubble"><div className="chat-text"><Markdown>{said.text}</Markdown></div></div>)}
              {onReply && said.text.trim() && (
                <p className="chat-under">
                  <button type="button" className="chat-reply" aria-label={`Reply to ${name(said.from)}'s answer`}
                    onClick={() => onReply(answerReply(message.replyTo, { runId: null, messageId: `note:${message.id}`, from: said.from, to: null, kind: 'answer', text: said.text }), said.from)}>
                    <Reply size={12} aria-hidden="true" />Reply
                  </button>
                </p>
              )}
            </div>
          </li>
        ))}
        {couldNotAnswer(answers.failed ?? []).map(({ from, error }) => (
          <li key={`failed-${from.join(' ')}`} className="tc-said-failed">
            <Appearing className="tc-stopped bad" role="status">
              <p><b><StatusGlyph status="failed" size={10} />{listNames(from.map(name))} didn’t answer.</b> {plainRunError(error.split('\n')[0])}</p>
              {problemAction(error) && <div className="tc-acts"><FixIt message={error} filled={fixFill === fixKey(message.id, error)} /></div>}
            </Appearing>
          </li>
        ))}
        {waiting.map((id) => (
          <li key={`writing-${id}`} className="chat-msg tc-said-back tc-appear">
            {face(id)}
            <div className="chat-stack">
              <div className={`chat-meta hue-${hue(id)}`}><span className="chat-name">{name(id)}</span></div>
              <div className="chat-bubble typing" role="status" aria-label={`${name(id)} is writing`}><span className="chat-dots" aria-hidden="true"><i /><i /><i /></span></div>
            </div>
          </li>
        ))}
        {lessons && lessons.length > 0 && <li className="tc-said-learned"><Learned lessons={lessons} name={name} onUndo={onUndoLesson} onTellAll={onTellAllLesson} /></li>}
        {waiting.length === 0 && (
          <li className="tc-said-acts">
            <span>No work started</span>
            <button type="button" className="tc-link" disabled={starting} onClick={() => { setStarting(true); onStart() }}><Play size={11} aria-hidden="true" />Start {to} on this</button>
          </li>
        )}
      </>
    )
  }
  return (
    <li ref={shown} className={`chat-msg mine tc-team-note${appear ? ' tc-appear' : ''}${lit}`}>
      <div className="chat-stack">
        <div className="chat-meta"><span className="tc-to">You → the team · note</span><time>{clockTime(message.createdAt)}</time></div>
        {yours(<div className="chat-bubble">
          {message.replyTo && <ReplyQuote reply={message.replyTo} name={name} onShow={onShowReplied(message.replyTo)} />}
          {message.files && <ChatFiles files={message.files} />}
          <div className="chat-text"><SaidText text={message.text} /></div>
        </div>)}
        <div className="chat-under">
          <span>Starts nothing · the team reads it next time</span>
          <button type="button" className="tc-link" disabled={starting} onClick={() => { setStarting(true); onStart() }}><Play size={11} aria-hidden="true" />Start the team on this</button>
        </div>
      </div>
    </li>
  )
}

/**
 * The one stop whose way out is the screen's gold fill (DESIGN_LANGUAGE §8): the newest shown that
 * LoomWatch knows how to fix, and only while nothing waits on your answer. A piece of work is named
 * by its run, agents that could not answer by their note and cause (`fixKey`).
 */
function filledFix(items: readonly ChatItem[], decision: OpenDecision | null): string | null {
  if (decision) return null
  for (const item of [...items].reverse()) {
    if (item.kind === 'work') {
      if (item.run.status === 'failed' && !tryingAgain(item.run) && problemAction(item.run.error)) return item.run.runId
      continue
    }
    const fixable = couldNotAnswer(item.message.answers?.failed ?? []).findLast((group) => problemAction(group.error))
    if (fixable) return fixKey(item.message.id, fixable.error)
  }
  return null
}

function fixKey(messageId: string, error: string): string {
  return `${messageId}\n${error}`
}

/** The agents that could not answer a note, those stopped by the same thing together: one card,
    and one way to fix it, for a team that ran out of credits all at once. */
function couldNotAnswer(failed: readonly NoteFailure[]): { from: string[]; error: string }[] {
  const groups: { from: string[]; error: string }[] = []
  for (const failure of failed) {
    const same = groups.find((group) => group.error === failure.error)
    if (same) same.from.push(failure.from)
    else groups.push({ from: [failure.from], error: failure.error })
  }
  return groups
}

/** A message on its way, or one the daemon did not take. */
function Pending({ message, name, onRetry, onEdit, onDismiss }: { message: PendingMessage; name: (id: string) => string; onRetry: () => void; onEdit: () => void; onDismiss: () => void }) {
  return (
    <li className={`chat-msg mine tc-pending tc-appear${message.state === 'failed' ? ' failed' : ''}`}>
      <div className="chat-stack">
        <div className="chat-meta"><span className="tc-to">{message.state === 'sending' ? 'Sending…' : 'Not sent'}</span></div>
        <div className="chat-bubble">
          {message.replyTo && <ReplyQuote reply={message.replyTo} name={name} />}
          <ChatFiles files={message.files} />
          <div className="chat-text"><SaidText text={message.text} /></div>
        </div>
        {message.state === 'failed' && (
          <div className="chat-under tc-pending-acts">
            <span className="chat-failed">{message.error}</span>
            <button type="button" className="tc-link" onClick={onRetry}><RotateCcw size={11} aria-hidden="true" />Try again</button>
            <button type="button" className="tc-link" onClick={onEdit}>Edit</button>
            <button type="button" className="tc-link" onClick={onDismiss} aria-label="Remove this message"><X size={11} aria-hidden="true" /></button>
          </div>
        )}
      </div>
    </li>
  )
}

function routeChanged(route: string, agent: string, solo = false): string {
  if (route === 'note') return `${agent} was working, so your message became a note for its next turn.`
  if (route === 'agent') return solo ? `${agent} had finished, so your message started new work.` : `${agent} had finished, so your message started it on its own.`
  if (route === 'team_note') return 'Nobody was working any more, so your message became a team note.'
  return 'Your message started the team.'
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : name.slice(0, 2)).toUpperCase()
}

