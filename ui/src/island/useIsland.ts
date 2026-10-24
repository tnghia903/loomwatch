// The island at the notch, at work (ADR 0083): reads what the teams are doing every couple of
// seconds, hears the Mac app, keeps the timers, finds the figures and sends the answers. What it
// all means is `islandReducer`'s business.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'

import { fetchChatPage, fetchNotesAnswering } from '../lib/chat/client'
import { agentFigure, figureFor, type FigureChoice } from '../lib/library/figures'
import { fetchJobs, type SavedJob } from '../lib/library/jobs'
import { fetchPinnedAgent } from '../lib/library/pinned'
import { crewOf, type CrewAgent } from '../lib/rail/teamCrews'
import { answerPermission, fetchRecentRuns, fetchRun } from '../lib/runs/client'
import { PERMISSION_SAID } from '../lib/runs/permissionRequests'
import { answerTeamRequest, fetchTeamRequests, type TeamRequest } from '../lib/runs/teamRequests'
import type { Ticket } from '../lib/story/needsYou'
import { fetchTeamFile } from '../lib/team-file/client'
import { inApp, listen, openInLoomWatch, tellApp } from './bridge'
import type { Intake } from './intake'
import { pinnedNow, pinnedWorking, sendToPinned, type PinnedNow } from './pinned'
import { wakesAt } from './popouts'
import { initialIsland, islandReducer, viewOf, type IslandAction, type IslandState, type IslandViewName } from './state'
import { copyText, tucked, type TeamNow, type Tucked } from './teams'
import { ISLAND_WAITS } from './waits'

const NO_TEAMS: TeamNow[] = []

/** How far back the island looks for finished runs: an hour, as the menu bar does. */
const FINISHED_WITHIN_SECONDS = 60 * 60

/** A finished answer of the pinned agent, read whole: what its card shows, and what it carries away. */
export interface WholeAnswer {
  /** As it was written, in Markdown. */
  text: string
  /** For an app that takes no formatting: links keep their addresses. */
  plain: string
  /** Formatted, for an app that takes it; `null` when it couldn't be made. */
  html: string | null
}

export interface Island {
  view: IslandViewName
  teams: TeamNow[]
  shown: IslandState['shown']
  tucked: Tucked
  notch: { width: number; height: number }
  /** The island is around a real notch; on a screen without one it draws its own. */
  atNotch: boolean
  bar: number
  now: number
  /** A waiting question's figure bounces. */
  nudge: boolean
  /** The question being answered, the one whose answer did not go through, and what an answer
      did, said for a moment before the card goes. */
  busy: string | null
  failed: string | null
  said: { ticket: string; text: string } | null
  figure: (teamPath: string, agent: string | null) => FigureChoice
  /** The figures of a team's agents, from its file: none until it is read. */
  crewFigures: (teamPath: string) => FigureChoice[]
  answer: (team: TeamNow, ticket: Ticket, decision: 'allow_once' | 'deny') => void
  open: (team: TeamNow) => void
  openApp: () => void
  pointerOnIsland: (over: boolean) => void
  pointerOnDrop: (over: boolean) => void
  /** The agent pinned to the notch, and writing to it: the message so far, whether it is at work
      (a message then joins its turn), and what sending did. */
  pinned: PinnedNow | null
  composing: boolean
  draft: string
  setDraft: (text: string) => void
  pinnedWorking: boolean
  sending: boolean
  sent: { ok: boolean; text: string } | null
  /** The message box has the keyboard, or lost it to another part of the island. */
  compose: (on: boolean) => void
  /** Escape: stop writing, and give the keyboard back to whatever had it. */
  putAway: () => void
  /** Send what is in the box, or `job` (a chip), with whatever was dropped into the slot. */
  send: (job?: string) => void
  /** Its Chat tab in LoomWatch, where the message can be sent when the island couldn't. */
  openPinned: () => void
  /** What was dropped into the slot, waiting for a job; dropping, dragging over, and taking it out. */
  intake: Intake | null
  drop: (intake: Intake) => void
  dragOver: (over: boolean) => void
  clearIntake: () => void
  /** The whole answer of a finished turn of the pinned agent, once read: what its card shows, and
      what Copy takes. `null` until then, when Copy is off. */
  answerOf: (team: TeamNow) => WholeAnswer | null
  /** Copy an answer. */
  copy: (answer: WholeAnswer) => void
  copied: boolean
  /** Start one of your teams on what the pinned agent asked it, or say not now. */
  answerTeam: (request: TeamRequest, decision: 'start' | 'decline') => void
  teamBusy: string | null
  teamFailed: string | null
  /** What a Start or Not now did, said for a moment before the card goes. */
  teamSaid: { id: string; text: string } | null
}

export function useIsland(): Island {
  const [state, dispatch] = useReducer(
    (current: IslandState, action: IslandAction) => islandReducer(current, { ...action, now: Date.now() }),
    undefined,
    () => initialIsland(Date.now(), inApp()),
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [said, setSaid] = useState<{ ticket: string; text: string } | null>(null)
  const [nudge, setNudge] = useState(false)
  const [pinnedId, setPinnedId] = useState<string | null | undefined>(undefined)
  const [saved, setSaved] = useState<readonly SavedJob[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<{ ok: boolean; text: string } | null>(null)

  // What the teams are doing, every couple of seconds: their runs, and the messages their agents
  // answer in the chat, which no run has. While `loomwatchd` doesn't answer, the island keeps what
  // it last knew.
  const read = useCallback(() => {
    Promise.all([
      fetchRecentRuns(FINISHED_WITHIN_SECONDS),
      fetchNotesAnswering(FINISHED_WITHIN_SECONDS).catch(() => null),
      fetchTeamRequests(FINISHED_WITHIN_SECONDS).catch(() => null),
    ]).then(([records, notes, requests]) => dispatch({ type: 'runs', records, notes, requests }), () => {})
    fetchPinnedAgent().then(setPinnedId, () => {})
  }, [])
  useEffect(() => {
    read()
    const id = window.setInterval(read, ISLAND_WAITS.poll)
    return () => window.clearInterval(id)
  }, [read])

  // The app's side: where the panel is, whether it is the live island, the pointer, the person,
  // the screen, a click elsewhere, and results looked at on another screen's island.
  const toldSeen = useRef(new Set<string>())
  useEffect(() => {
    const stop = listen((message) => {
      if (message.kind === 'seen') for (const run of message.runs) toldSeen.current.add(run)
      dispatch({ type: 'app', message })
    })
    tellApp({ kind: 'ready' })
    return stop
  }, [])
  // Results looked at here leave the other screens' islands too.
  const seen = state.seen
  useEffect(() => {
    const runs = [...seen].filter((run) => !toldSeen.current.has(run))
    if (!runs.length) return
    for (const run of runs) toldSeen.current.add(run)
    tellApp({ kind: 'seen', runs })
  }, [seen])

  // My agents: read at the start, when another agent is pinned, and as the list opens, so the
  // pinned agent's name, figure and instructions are as saved.
  const readSaved = useCallback(() => { fetchJobs().then((list) => setSaved(list?.jobs ?? []), () => {}) }, [])
  useEffect(readSaved, [readSaved, pinnedId])
  const listOpen = state.listOpen
  useEffect(() => { if (listOpen) readSaved() }, [readSaved, listOpen])
  const pinned = useMemo(() => pinnedNow(pinnedId ?? null, saved), [pinnedId, saved])
  useEffect(() => { dispatch({ type: 'pinned', pinned }) }, [pinned])
  // The app hears whether an agent is pinned, so ⌃⌥Space has a box to open.
  const pinnedName = pinned?.name ?? null
  useEffect(() => {
    if (pinnedId !== undefined) tellApp({ kind: 'pinned', name: pinnedName })
  }, [pinnedId, pinnedName])

  // The next moment to tuck away or bring out; and "4m" moving on.
  const wake = wakesAt(state.pop)
  useEffect(() => {
    if (wake === null) return
    const id = window.setTimeout(() => dispatch({ type: 'tick' }), Math.max(0, wake - Date.now()) + 20)
    return () => window.clearTimeout(id)
  }, [wake])
  useEffect(() => {
    const id = window.setInterval(() => dispatch({ type: 'tick' }), 30_000)
    return () => window.clearInterval(id)
  }, [])

  // The list stays open a moment after the pointer leaves it, or after a message to the pinned
  // agent is no longer being written.
  useEffect(() => {
    if (state.onIsland || !state.listOpen || state.composing) return
    const id = window.setTimeout(() => dispatch({ type: 'closeList' }), ISLAND_WAITS.closeList)
    return () => window.clearTimeout(id)
  }, [state.onIsland, state.listOpen, state.composing])

  const view = viewOf(state)
  const teams = state.teams ?? NO_TEAMS
  const summary = tucked(teams)

  // A waiting question's figure bounces now and then while the island is tucked away.
  const waiting = view === 'tucked' && summary.asks > 0
  useEffect(() => {
    if (!waiting) return
    let settle: number | undefined
    const id = window.setInterval(() => {
      setNudge(true)
      settle = window.setTimeout(() => setNudge(false), 900)
    }, ISLAND_WAITS.nudge)
    return () => {
      window.clearInterval(id)
      window.clearTimeout(settle)
    }
  }, [waiting])

  const { figure, crewFigures } = useFigures(teams, saved, pinned)

  // Writing to the pinned agent takes the keyboard from whatever had it. It goes back once the
  // message is sent, on Escape, or when the list closes; not as soon as the box loses it, because
  // the panel giving it back mid-click on another of the island's buttons could lose that click.
  const keyboard = useRef(false)
  const giveBack = useCallback(() => {
    if (!keyboard.current) return
    keyboard.current = false
    tellApp({ kind: 'keyboard', on: false })
  }, [])
  const compose = useCallback((on: boolean) => {
    dispatch({ type: 'compose', on })
    if (!on) return
    keyboard.current = true
    tellApp({ kind: 'keyboard', on: true })
  }, [])
  const putAway = useCallback(() => {
    dispatch({ type: 'compose', on: false })
    giveBack()
  }, [giveBack])
  useEffect(() => { if (!listOpen) giveBack() }, [listOpen, giveBack])
  // Escape while writing, wherever the keyboard is in the island (the box, a button reached from
  // it, or nowhere once Copy has said "Copied."), puts it away and gives the keyboard back.
  const composing = state.composing
  useEffect(() => {
    if (!composing) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      putAway()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [composing, putAway])
  const records = useRef(state.records)
  useEffect(() => { records.current = state.records })
  const intake = state.intake
  // A drag let go of somewhere else: the page heard it come over the island, but no drop and no
  // leaving followed once the button came up. The slot closes after a moment.
  const draggedNear = state.app.drag
  const draggedOver = state.dragOver
  useEffect(() => {
    if (draggedNear || !draggedOver) return
    const id = window.setTimeout(() => dispatch({ type: 'dragOver', over: false }), ISLAND_WAITS.dropSettle)
    return () => window.clearTimeout(id)
  }, [draggedNear, draggedOver])
  const send = useCallback((job?: string) => {
    const text = (job ?? draft).trim()
    if (!text || !pinned || sending) return
    setSending(true)
    setSent(null)
    sendToPinned(pinned, text, records.current, intake)
      .then(() => {
        if (job === undefined) setDraft('')
        dispatch({ type: 'intakeDone' })
        setSent({ ok: true, text: `Sent to ${pinned.name}.` })
        putAway()
        read()
      }, () => setSent({ ok: false, text: `That didn’t go through. Try again, or open ${pinned.name}’s chat.` }))
      .finally(() => setSending(false))
  }, [draft, pinned, sending, intake, putAway, read])

  // The whole answer of each finished turn of the pinned agent, read once: the run's reply, or for
  // a message it answered in the chat, its answer there. The island's own reading is cut short.
  // It counts as read once it is ready to take away too: as plain text and formatted.
  const [answers, setAnswers] = useState<ReadonlyMap<string, WholeAnswer>>(() => new Map())
  const reading = useRef(new Set<string>())
  useEffect(() => {
    for (const team of teams) {
      if (!team.pinned || team.moment !== 'done' || reading.current.has(team.runId)) continue
      reading.current.add(team.runId)
      const whole = team.chat
        ? fetchChatPage(team.teamPath, null, 10).then((page) => {
          const note = page.items.find((item) => item.kind === 'note' && item.message.id === team.runId)
          return note?.kind === 'note' ? note.message.answers?.said[0]?.text ?? null : null
        })
        : fetchRun(team.runId).then((record) => record.reply)
      whole
        .then(async (text) => {
          if (!text) return
          const html = await import('./answerHtml').then(({ answerHtml }) => answerHtml(text), () => null)
          setAnswers((was) => new Map(was).set(team.runId, { text, plain: copyText(text), html }))
        })
        .catch(() => { reading.current.delete(team.runId) })
    }
  }, [teams])
  const answerOf = useCallback((team: TeamNow) => answers.get(team.runId) ?? null, [answers])

  const [copied, setCopied] = useState(false)
  const copy = useCallback((answer: WholeAnswer) => {
    if (inApp()) tellApp({ kind: 'copy', text: answer.plain, html: answer.html })
    else void toClipboard(answer).catch(() => {})
    setCopied(true)
    window.setTimeout(() => setCopied(false), ISLAND_WAITS.sent)
  }, [])

  const [teamBusy, setTeamBusy] = useState<string | null>(null)
  const [teamFailed, setTeamFailed] = useState<string | null>(null)
  const [teamSaid, setTeamSaid] = useState<{ id: string; text: string } | null>(null)
  const answerTeam = useCallback((request: TeamRequest, decision: 'start' | 'decline') => {
    setTeamBusy(request.id)
    setTeamFailed(null)
    answerTeamRequest(request.id, decision)
      .then(() => {
        const who = pinned?.name ?? 'your agent'
        setTeamSaid({ id: request.id, text: decision === 'start' ? `${request.team.name} is starting.` : `${request.team.name} won’t start. Message ${who} if you still want it done.` })
        window.setTimeout(() => {
          setTeamSaid(null)
          dispatch({ type: 'answered', ticket: `team:${request.id}` })
          read()
        }, ISLAND_WAITS.sent)
      }, () => setTeamFailed(request.id))
      .finally(() => setTeamBusy(null))
  }, [read, pinned])
  // "Sent" says so for a moment.
  useEffect(() => {
    if (!sent?.ok) return
    const id = window.setTimeout(() => setSent(null), ISLAND_WAITS.sent)
    return () => window.clearTimeout(id)
  }, [sent])

  const answer = useCallback((team: TeamNow, ticket: Ticket, decision: 'allow_once' | 'deny') => {
    if (!ticket.requestId) return
    setBusy(ticket.id)
    setFailed(null)
    answerPermission(team.runId, ticket.requestId, decision)
      .then(() => {
        // Say what it did, then let the card go and drop the next question.
        setSaid({ ticket: ticket.id, text: PERMISSION_SAID[decision] })
        window.setTimeout(() => {
          setSaid(null)
          dispatch({ type: 'answered', ticket: ticket.id })
          read()
        }, ISLAND_WAITS.said)
      }, () => setFailed(ticket.id))
      .finally(() => setBusy(null))
  }, [read])

  const open = useCallback((team: TeamNow) => {
    openInLoomWatch(team.link)
    dispatch({ type: 'opened', runId: team.runId })
  }, [])

  const openApp = useCallback(() => {
    openInLoomWatch('/')
    dispatch({ type: 'closeList' })
  }, [])

  const { notch, menuBar } = state.app
  return {
    view,
    teams,
    shown: state.shown,
    tucked: summary,
    notch: notch ?? { width: 160, height: menuBar },
    atNotch: notch !== null,
    bar: notch?.height ?? menuBar,
    now: state.now,
    nudge,
    busy,
    failed,
    said,
    figure,
    crewFigures,
    answer,
    open,
    openApp,
    pointerOnIsland: useCallback((over: boolean) => dispatch({ type: 'pointerOnIsland', over }), []),
    pointerOnDrop: useCallback((over: boolean) => dispatch({ type: 'pointerOnDrop', over }), []),
    pinned,
    composing: state.composing,
    draft,
    setDraft,
    pinnedWorking: pinned ? pinnedWorking(state.records, pinned) : false,
    sending,
    sent,
    compose,
    putAway,
    send,
    openPinned: useCallback(() => {
      if (!pinned) return
      openInLoomWatch(pinned.link)
      dispatch({ type: 'closeList' })
    }, [pinned]),
    intake,
    drop: useCallback((dropped: Intake) => dispatch({ type: 'drop', intake: dropped }), []),
    dragOver: useCallback((over: boolean) => dispatch({ type: 'dragOver', over }), []),
    clearIntake: useCallback(() => dispatch({ type: 'intakeDone' }), []),
    answerOf,
    copy,
    copied,
    answerTeam,
    teamBusy,
    teamFailed,
    teamSaid,
  }
}

/**
 * The figures, as the app draws them: each team's agents from its file, each wearing its saved
 * agent's figure when it was placed from Your agents; one picked from its id otherwise.
 */
/** Outside the Mac app: both kinds on the clipboard where the browser can, else the plain text. */
async function toClipboard(answer: WholeAnswer): Promise<void> {
  if (answer.html && typeof ClipboardItem === 'function' && navigator.clipboard?.write) {
    await navigator.clipboard.write([new ClipboardItem({
      'text/plain': new Blob([answer.plain], { type: 'text/plain' }),
      'text/html': new Blob([answer.html], { type: 'text/html' }),
    })])
    return
  }
  await navigator.clipboard?.writeText(answer.plain)
}

function useFigures(teams: readonly TeamNow[], saved: readonly SavedJob[], pinned: PinnedNow | null): Pick<Island, 'figure' | 'crewFigures'> {
  const [crews, setCrews] = useState<ReadonlyMap<string, readonly CrewAgent[]>>(() => new Map())
  const asked = useRef(new Set<string>())
  useEffect(() => {
    // Each team at work, and each team the pinned agent asks to start.
    const paths = teams.flatMap((team) => [team.teamPath, ...(team.teamAsks ?? []).map((request) => request.team.path)])
    for (const path of paths) {
      if (asked.current.has(path)) continue
      asked.current.add(path)
      fetchTeamFile(path).then((file) => {
        const crew = crewOf(file.yaml)
        if (crew) setCrews((was) => new Map(was).set(path, crew.agents))
      }, () => {})
    }
  }, [teams])
  const figure = useCallback((teamPath: string, agent: string | null): FigureChoice => {
    // The pinned agent wears its own figure in its chat too.
    if (pinned && teamPath === pinned.chatPath) return figureFor(pinned.id, pinned.job.figure)
    if (!agent) return figureFor(teamPath)
    const placed = crews.get(teamPath)?.find((each) => each.id === agent)
    return agentFigure(placed ?? { id: agent }, saved)
  }, [crews, saved, pinned])
  const crewFigures = useCallback((teamPath: string) => (crews.get(teamPath) ?? []).map((agent) => agentFigure(agent, saved)), [crews, saved])
  return { figure, crewFigures }
}
