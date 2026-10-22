// The island at the notch, at work (ADR 0083): reads what the teams are doing every couple of
// seconds, hears the Mac app, keeps the timers, finds the figures and sends the answers. What it
// all means is `islandReducer`'s business.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'

import { agentFigure, figureFor, type FigureChoice } from '../lib/library/figures'
import { fetchJobs, type SavedJob } from '../lib/library/jobs'
import { crewOf, type CrewAgent } from '../lib/rail/teamCrews'
import { answerPermission, fetchRecentRuns } from '../lib/runs/client'
import { PERMISSION_SAID } from '../lib/runs/permissionRequests'
import type { Ticket } from '../lib/story/needsYou'
import { fetchTeamFile } from '../lib/team-file/client'
import { inApp, listen, openInLoomWatch, tellApp } from './bridge'
import { wakesAt } from './popouts'
import { initialIsland, islandReducer, viewOf, type IslandAction, type IslandState, type IslandViewName } from './state'
import { tucked, type TeamNow, type Tucked } from './teams'
import { ISLAND_WAITS } from './waits'

/** How far back the island looks for finished runs: an hour, as the menu bar does. */
const FINISHED_WITHIN_SECONDS = 60 * 60

export interface Island {
  view: IslandViewName
  teams: TeamNow[]
  shown: IslandState['shown']
  tucked: Tucked
  notch: { width: number; height: number }
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
  answer: (team: TeamNow, ticket: Ticket, decision: 'allow_once' | 'deny') => void
  open: (team: TeamNow) => void
  openApp: () => void
  pointerOnIsland: (over: boolean) => void
  pointerOnDrop: (over: boolean) => void
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

  // What the teams are doing, every couple of seconds. While `loomwatchd` doesn't answer, the
  // island keeps what it last knew.
  const read = useCallback(() => {
    fetchRecentRuns(FINISHED_WITHIN_SECONDS).then((records) => dispatch({ type: 'runs', records }), () => {})
  }, [])
  useEffect(() => {
    read()
    const id = window.setInterval(read, ISLAND_WAITS.poll)
    return () => window.clearInterval(id)
  }, [read])

  // The app's side: where the panel is, the pointer, the person, the screen, a click elsewhere.
  useEffect(() => {
    const stop = listen((message) => dispatch({ type: 'app', message }))
    tellApp({ kind: 'ready' })
    return stop
  }, [])

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

  // The list stays open a moment after the pointer leaves it.
  useEffect(() => {
    if (state.onIsland || !state.listOpen) return
    const id = window.setTimeout(() => dispatch({ type: 'closeList' }), ISLAND_WAITS.closeList)
    return () => window.clearTimeout(id)
  }, [state.onIsland, state.listOpen])

  const view = viewOf(state)
  const teams = state.teams ?? []
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

  const figure = useFigures(teams)

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
    bar: notch?.height ?? menuBar,
    now: state.now,
    nudge,
    busy,
    failed,
    said,
    figure,
    answer,
    open,
    openApp,
    pointerOnIsland: useCallback((over: boolean) => dispatch({ type: 'pointerOnIsland', over }), []),
    pointerOnDrop: useCallback((over: boolean) => dispatch({ type: 'pointerOnDrop', over }), []),
  }
}

/**
 * The figures, as the app draws them: each team's agents from its file, each wearing its saved
 * agent's figure when it was placed from Your agents; one picked from its id otherwise.
 */
function useFigures(teams: readonly TeamNow[]): (teamPath: string, agent: string | null) => FigureChoice {
  const [crews, setCrews] = useState<ReadonlyMap<string, readonly CrewAgent[]>>(() => new Map())
  const [saved, setSaved] = useState<readonly SavedJob[]>([])
  const asked = useRef(new Set<string>())
  useEffect(() => {
    fetchJobs().then((list) => setSaved(list?.jobs ?? []), () => {})
  }, [])
  useEffect(() => {
    for (const team of teams) {
      if (asked.current.has(team.teamPath)) continue
      asked.current.add(team.teamPath)
      fetchTeamFile(team.teamPath).then((file) => {
        const crew = crewOf(file.yaml)
        if (crew) setCrews((was) => new Map(was).set(team.teamPath, crew.agents))
      }, () => {})
    }
  }, [teams])
  return useCallback((teamPath: string, agent: string | null): FigureChoice => {
    if (!agent) return figureFor(teamPath)
    const placed = crews.get(teamPath)?.find((each) => each.id === agent)
    return agentFigure(placed ?? { id: agent }, saved)
  }, [crews, saved])
}
