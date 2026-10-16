import { ArrowDown, ChevronDown, ChevronRight, Play, RotateCcw, Search, X } from 'lucide-react'
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { continueWithTeam, fetchChatPage, itemAt, sendChatMessage, startFromNote, type ChatItem, type ChatMessage, type ChatTarget } from '../../lib/chat/client'
import { clockTime, dayKey, dayLabel } from '../../lib/chat/format'
import { destination, withMention, type ChatAgent } from '../../lib/chat/route'
import { markSeen } from '../../lib/chat/seen'
import { AppearContext, useAppear } from '../../lib/chat/appear'
import { FollowContext, type ChatFollow } from '../../lib/chat/follow'
import { useTeamChat, type PendingMessage } from '../../lib/chat/useTeamChat'
import { DaemonUnreachableError } from '../../lib/daemonFetch'
import { failedAgent } from '../../lib/runs/errors'
import { answerRun, newStartKey, RunApiError, STALE_TEAM_REVISION, TEAM_NEEDS_REVIEW, type RunRecord, type TeamReview } from '../../lib/runs/client'
import type { ReceiptLine } from '../../lib/story/receipt'
import type { AllowSwitch } from '../../lib/team-file/types'
import { AgentFacesContext, type AgentFaces } from '../../lib/chat/faces'
import { batonWords, sameBaton, type Baton } from '../../lib/chat/baton'
import { usePieceLine } from '../../lib/chat/pieceLine'
import { AgentFace } from './AgentFace'
import { AvatarFace } from '../agents/AvatarFace'
import { BatonFlight } from './BatonFlight'
import { BatonPill } from './BatonPill'
import { Swap } from './Appearing'
import type { AutoModeControl } from './AutoModeSwitch'
import { ChatComposer, type OpenDecision } from './ChatComposer'
import { WorkPiece, type TeamView } from './WorkPiece'

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
  onAlwaysAllow?: (agentId: string, key: AllowSwitch) => void
  /** Who decides the commands agents ask to run, the switch beside the message box (ADR 0061). */
  autoMode?: AutoModeControl
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
}

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
 * With `team.solo` it is one agent's own chat (Your agents): everything you write goes to that
 * agent, starting its work when it is free and joining its turn while it works, so there is no @.
 */
export function TeamChat({ teamPath, teamName, agents, team, steps, suggestion, routine, detailsRunId, answerRunId = null, onOpenAnswer, blocked, prepare, onDetails, onTeamReview, onStale, onAlwaysAllow, announce, onNewest, onStarted, reveal = null, onOpenFinding, autoMode, onNewestRun }: TeamChatProps) {
  const chat = useTeamChat(teamPath)
  const [draft, setDraft] = useState('')
  // Once the first page has painted, what arrives is news and moves in (lib/chat/appear.ts).
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    if (!chat.loaded || settled || chat.loadingOlder) return
    const frame = requestAnimationFrame(() => setSettled(true))
    return () => cancelAnimationFrame(frame)
  }, [chat.loaded, settled, chat.loadingOlder])
  const search = useChatSearch(teamPath)
  const startKeys = useRef(new Map<string, string>())
  const scroller = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const restore = useRef<number | null>(null)
  const runs = useMemo(() => new Map(chat.items.flatMap((item) => (item.kind === 'work' ? [[item.run.runId, item.run] as const] : []))), [chat.items])
  const continuedFrom = useMemo(() => new Set(chat.items.flatMap((item) => (item.kind === 'work' && item.run.followsRunId && !item.run.onlyAgent ? [item.run.followsRunId] : []))), [chat.items])

  // What the team is waiting on you for: the newest open review or question.
  const decision = useMemo<OpenDecision | null>(() => {
    for (const run of [...chat.live].sort((left, right) => right.createdAt.localeCompare(left.createdAt))) {
      const waiting = run.waitingOn
      if (!waiting) continue
      const from = waiting.kind === 'review_stop' ? waiting.handoverFrom ?? waiting.node : waiting.node
      return { runId: run.runId, node: waiting.node, kind: waiting.kind, from, fromName: team.names.get(from) ?? from }
    }
    return null
  }, [chat.live, team.names])

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
  const resend = useRef<(text: string, to: ChatTarget, now: boolean) => Promise<boolean>>(async () => false)
  const restart = useRef<(message: ChatMessage) => Promise<void>>(async () => {})
  const send = useCallback(async (text: string, to: ChatTarget, now: boolean, retryOf?: string): Promise<boolean> => {
    const where = destination(to, live, team.names, steps, now)
    const startsWork = where.route === 'team' || where.route === 'agent'
    let revision: string | null = null
    if (startsWork) {
      const prepared = await prepare()
      if (!prepared.ok) { announce(prepared.error); return false }
      revision = prepared.revision
    }
    if (retryOf) chat.dismissPending(retryOf)
    const localId = chat.beginSend(text, to, now)
    const key = (retryOf && startKeys.current.get(retryOf)) || newStartKey()
    startKeys.current.set(localId, key)
    atBottom.current = true
    try {
      const result = await sendChatMessage({ teamPath, text, to, now, expectedRevision: revision, startKey: startsWork ? key : undefined })
      chat.settleSend(localId, result)
      if ((result.route === 'team' || result.route === 'agent') && result.run) onStarted?.(result.run.runId)
      startKeys.current.delete(localId)
      if (result.route !== where.route) announce(routeChanged(result.route, team.names.get(result.message.agentId ?? '') ?? result.message.agentId ?? '', Boolean(team.solo)))
      return true
    } catch (caught) {
      if (caught instanceof RunApiError && caught.code === TEAM_NEEDS_REVIEW && caught.review) {
        chat.dismissPending(localId)
        // Held in the box meanwhile; once "Trust and run" sends it, the box lets it go.
        onTeamReview(caught.review, () => {
          void resend.current(text, to, now).then((sent) => { if (sent) setDraft((current) => (current.trim() === text ? '' : current)) })
        })
        return false
      }
      if (caught instanceof RunApiError && caught.code === STALE_TEAM_REVISION) onStale()
      chat.failSend(localId, caught instanceof DaemonUnreachableError ? caught.message : caught instanceof Error ? caught.message : String(caught))
      return true
    }
  }, [live, team.names, team.solo, steps, prepare, chat, teamPath, announce, onTeamReview, onStale, onStarted])

  useEffect(() => { resend.current = send }, [send])

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
    void send(text, item.run.onlyAgent ? { kind: 'agent', agent: item.run.onlyAgent } : { kind: 'team' }, false)
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
  const asking = new Set(live.flatMap((run) => (run.permissionRequests ?? []).map((request) => request.agent)))
  const failed = failedNow(runs.values())
  const presence = members.map((agent) => ({ agent, state: (unreachable ? 'away' : waitingFor === agent.id || asking.has(agent.id) ? 'waiting' : workingNow.has(agent.id) ? 'working' : failed.has(agent.id) ? 'failed' : 'idle') as Presence }))
  // Each face can say who its agent is, and puts `@name` in the message box when clicked.
  const [mentioned, setMentioned] = useState(0)
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
        app: team.apps?.get(id) ?? null,
        model: config?.model?.trim() || null,
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
    <AppearContext.Provider value={settled && search.results === null}>
    <FollowContext.Provider value={follow}>
    <AgentFacesContext.Provider value={faces}>
    <section className="tc" aria-label={`${teamName} chat`} data-tour="chat" data-newest-run={newestRun ?? undefined}>
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
                onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); search.close() } }}
                placeholder="Search this chat"
                aria-label="Search this chat"
              />
              <button type="button" className="tc-link" onClick={search.close} aria-label="Close search"><X size={13} aria-hidden="true" /></button>
            </label>
          ) : (
            <button type="button" className="tc-link" onClick={() => search.setOpen(true)} aria-label="Search this chat"><Search size={14} aria-hidden="true" /></button>
          )}
          {routine && <div className="tc-routine">{routine}</div>}
        </div>
      </header>

      <div className="tc-scroll" ref={scroller} onScroll={onScroll} onPointerDown={() => { touched.current = performance.now() }} onKeyDown={() => { touched.current = performance.now() }}>
        {chat.more && (
          <div className="tc-older">
            <button type="button" className="btn" disabled={chat.loadingOlder} onClick={loadOlder}>{chat.loadingOlder ? 'Loading earlier work…' : 'Show earlier work'}</button>
          </div>
        )}
        {!chat.loaded && <p className="tc-loading" role="status">Loading the chat…</p>}
        {chat.loaded && chat.items.length === 0 && chat.pending.length === 0 && !chat.error && (
          <div className="tc-empty">
            <WeaveMark />
            {soloAgent ? <>
              <h3>Talk to {soloAgent.name || soloAgent.id}</h3>
              <p>Ask it for real work, the kind you would hand it. It works on it here, as it is on screen, and reads what was said before each time. Nothing here changes a team.</p>
            </> : <>
              <h3>Talk to {teamName}</h3>
              <p>Write <b>@team</b> and what you need to start the whole team, or <b>@</b> a name to ask one agent. Anything without an @ is a note the team reads the next time it works.</p>
            </>}
            {suggestion && (
              <button type="button" className="btn tc-suggest" onClick={() => setDraft(soloAgent ? suggestion : `@team ${suggestion}`)}>
                <Play size={13} aria-hidden="true" />{soloAgent ? suggestion : `@team ${suggestion}`}
              </button>
            )}
          </div>
        )}
        {search.results !== null && (
          <p className="tc-search-count" role="status">
            {search.loading ? 'Searching…' : `${search.results.length === 0 ? 'Nothing' : search.results.length === 1 ? 'One piece' : `${search.results.length} pieces`} in this chat ${search.results.length === 1 ? 'mentions' : 'mention'} “${search.text.trim()}”.`}
          </p>
        )}
        <ol className="tc-log" role="log" aria-label={search.results !== null ? 'Search results' : 'Messages'}>
          {(search.results ?? chat.items).map((item, index, list) => {
            const at = item.kind === 'work' ? item.run.createdAt : item.message.createdAt
            const previous = list[index - 1]
            const newDay = !previous || dayKey(previous.kind === 'work' ? previous.run.createdAt : previous.message.createdAt) !== dayKey(at)
            return (
              <Fragment key={item.kind === 'work' ? item.run.runId : item.message.id}>
                {newDay && <li className="tc-day" aria-hidden="true"><span>{dayLabel(at)}</span></li>}
                {item.kind === 'work'
                  ? <WorkPiece item={item} newest={item.run.runId === newestRun} reveal={reveal?.runId === item.run.runId ? reveal : null} followed={item.run.followsRunId ? runs.get(item.run.followsRunId) ?? null : null} continuedFrom={continuedFrom.has(item.run.runId)} team={team} draft={draft}
                      detailsOpen={detailsRunId === item.run.runId} answerOpen={answerRunId === item.run.runId} onDetails={onDetails} onOpenAnswer={onOpenAnswer} onRun={chat.applyRun} onBaton={onBaton} onLine={line.onLine} onTryAgain={tryAgain} onContinue={keepGoing}
                      onDecided={() => setDraft('')} onAlwaysAllow={onAlwaysAllow} onOpenFinding={onOpenFinding} />
                  : <TeamNote message={item.message} onStart={() => void startNote(item.message)} />}
              </Fragment>
            )
          })}
          {search.results === null && chat.pending.map((message) => (
            <Pending key={message.localId} message={message} onRetry={() => void send(message.text, message.to, message.now, message.localId)} onEdit={() => { chat.dismissPending(message.localId); setDraft(message.text) }} onDismiss={() => chat.dismissPending(message.localId)} />
          ))}
        </ol>
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
        autoMode={autoMode}
        value={draft}
        onChange={setDraft}
        onSend={(text, to, now) => send(text, to, now)}
        onAnswer={answer}
        mentioned={mentioned}
        solo={soloAgent}
      />
      {line.flight && <BatonFlight key={line.flight.id} flight={line.flight} holding={holding} onDone={line.done} />}
    </section>
    </AgentFacesContext.Provider>
    </FollowContext.Provider>
    </AppearContext.Provider>
  )
}

/** LoomWatch's mark, woven in when an empty chat opens: the weft first, then the warp across it. */
function WeaveMark() {
  return (
    <svg className="tc-weave" width="72" height="32" viewBox="0 0 102 44" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path className="tc-weave-warp" pathLength={1} d="M6 10 24 34 42 10 60 34 78 10 96 34" />
      <path className="tc-weave-weft" pathLength={1} d="M6 34 24 10 42 34 60 10 78 34 96 10" />
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
 * Search within the team's chat: the daemon matches the words across every piece and note, not
 * just the pages already read. Results replace the log until the search is closed.
 */
function useChatSearch(teamPath: string) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  // Results are kept with the words they answer, so stale ones never show for new words.
  const [found, setFound] = useState<{ words: string; items: ChatItem[] } | null>(null)
  const words = text.trim()
  const searching = open && words.length >= 2
  useEffect(() => {
    if (!searching) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void fetchChatPage(teamPath, null, 50, controller.signal, words)
        .then((page) => setFound({ words, items: [...page.items].sort((left, right) => itemAt(left).localeCompare(itemAt(right))) }))
        .catch(() => { if (!controller.signal.aborted) setFound({ words, items: [] }) })
    }, 250)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [searching, words, teamPath])
  const results = searching ? (found?.words === words ? found.items : []) : null
  const loading = searching && found?.words !== words
  const close = () => { setOpen(false); setText('') }
  return { open, setOpen, text, setText, results, loading, close }
}

/** A note to the whole team: it starts nothing, and the next work reads it. */
function TeamNote({ message, onStart }: { message: ChatMessage; onStart: () => void }) {
  const [starting, setStarting] = useState(false)
  const appear = useAppear()
  return (
    <li className={`chat-msg mine tc-team-note${appear ? ' tc-appear' : ''}`}>
      <div className="chat-stack">
        <div className="chat-meta"><span className="tc-to">You → the team · note</span><time>{clockTime(message.createdAt)}</time></div>
        <div className="chat-bubble"><div className="chat-text tc-plain">{message.text}</div></div>
        <div className="chat-under">
          <span>Starts nothing · the team reads it next time</span>
          <button type="button" className="tc-link" disabled={starting} onClick={() => { setStarting(true); onStart() }}><Play size={11} aria-hidden="true" />Start the team on this</button>
        </div>
      </div>
    </li>
  )
}

/** A message on its way, or one the daemon did not take. */
function Pending({ message, onRetry, onEdit, onDismiss }: { message: PendingMessage; onRetry: () => void; onEdit: () => void; onDismiss: () => void }) {
  return (
    <li className={`chat-msg mine tc-pending tc-appear${message.state === 'failed' ? ' failed' : ''}`}>
      <div className="chat-stack">
        <div className="chat-meta"><span className="tc-to">{message.state === 'sending' ? 'Sending…' : 'Not sent'}</span></div>
        <div className="chat-bubble"><div className="chat-text tc-plain">{message.text}</div></div>
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

