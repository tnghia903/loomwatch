import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import { keepIfSame } from '../keepIfSame'
import { answerPermission, answerRun, answerSpend, fetchRuns, type PermissionDecision, type RunRecord, type SpendDecision } from '../runs/client'
import { teamDisplayName } from '../team-file/client'
import { movedInPlace } from '../team-file/inPlace'
import { useTeamList } from '../team-file/useTeamList'
import { useLoomMarkState } from './loomMark'
import { APPROVAL_TEXT, ticketsFrom, type Ticket } from './needsYou'

const DISMISSED_KEY = 'loomwatch.needsYou.dismissed'
/** Said on the window when a stopped run is dismissed, so every reader of the poll leaves it out. */
const DISMISSED_EVENT = 'loomwatch:needs-you-dismissed'

let lastRecords: RunRecord[] = []

/**
 * One poll of the run registry for the whole page (round 3: the frame's dock and every screen read
 * the same records). It starts with the first reader and stops with the last; a team page that moved
 * in place starts from the last poll, so the tray, the mark and the tab don't blink.
 */
interface RunsSnapshot { records: RunRecord[]; error: string | null }
const runs = {
  snapshot: { records: [], error: null } as RunsSnapshot,
  readers: new Set<() => void>(),
  generation: 0,
  stop: null as (() => void) | null,
}
function told() { for (const reader of runs.readers) reader() }
async function refreshRuns(signal?: AbortSignal) {
  const mine = ++runs.generation
  try {
    const fetched = await fetchRuns(signal)
    if (signal?.aborted || mine !== runs.generation) return
    // Every screen draws from this list, so an answer that isn't one is an error, never a crash.
    if (!Array.isArray(fetched)) throw new Error('LoomWatch’s list of runs couldn’t be read.')
    lastRecords = fetched
    const records = keepIfSame(runs.snapshot.records, fetched)
    if (records !== runs.snapshot.records || runs.snapshot.error !== null) {
      runs.snapshot = { records, error: null }
      told()
    }
  } catch (caught) {
    if (signal?.aborted) return
    runs.snapshot = { ...runs.snapshot, error: caught instanceof Error ? caught.message : String(caught) }
    told()
  }
}
function startPolling() {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout>
  if (movedInPlace() && lastRecords.length) runs.snapshot = { records: lastRecords, error: null }
  // Keeps polling in a background tab, more slowly: the tab title and icon exist for exactly the
  // moment the operator is looking somewhere else.
  const tick = async () => {
    await refreshRuns(controller.signal)
    if (!controller.signal.aborted) timer = setTimeout(() => void tick(), document.hidden ? 15000 : 5000)
  }
  void tick()
  const wake = () => { if (!document.hidden) void refreshRuns(controller.signal) }
  document.addEventListener('visibilitychange', wake)
  runs.stop = () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', wake) }
}
function readRuns(reader: () => void) {
  runs.readers.add(reader)
  if (runs.readers.size === 1) startPolling()
  return () => {
    runs.readers.delete(reader)
    if (runs.readers.size > 0) return
    runs.stop?.()
    runs.stop = null
    runs.generation++
    runs.snapshot = { records: [], error: null }
  }
}
const runsNow = () => runs.snapshot

/** The run records every screen shares, from the one poll. */
export function useRunRecords(): RunsSnapshot {
  return useSyncExternalStore(readRuns, runsNow, runsNow)
}

/** The stopped runs the person dismissed from the tray, by run id: Home and a room leave them out too. */
export function loadDismissed(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as string[]) } catch { return new Set() }
}

/**
 * Polls the run registry for the needs-you tray, and shows the result where the operator looks
 * when they are not looking at LoomWatch: the tab title counts what waits on them, and the tab
 * icon carries a dot — gold, with the mark's "o" mouth, when something needs them, blue while a
 * team is working. The header's mark says the same from inside the app (`mark`,
 * lib/story/loomMark.ts).
 */
export function useNeedsYou() {
  const { records, error } = useRunRecords()
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissed)
  const { teams } = useTeamList()
  const refresh = useCallback((signal?: AbortSignal) => refreshRuns(signal), [])

  const names = useMemo(() => new Map((teams ?? []).map((team) => [team.path, teamDisplayName(team)])), [teams])
  const tickets = useMemo(() => ticketsFrom(records, names, dismissed), [records, names, dismissed])
  const working = useMemo(() => records.filter((record) => (record.status === 'running' || record.status === 'starting') && !record.waitingOn && !record.permissionRequests?.length && !record.spendStops?.length).length, [records])

  const dismiss = useCallback((runId: string) => {
    setDismissed((current) => {
      const next = new Set(current)
      next.add(runId)
      try { localStorage.setItem(DISMISSED_KEY, JSON.stringify([...next].slice(-200))) } catch { /* private mode */ }
      return next
    })
    window.dispatchEvent(new Event(DISMISSED_EVENT))
  }, [])
  useEffect(() => {
    const reread = () => setDismissed((current) => { const stored = loadDismissed(); return stored.size === current.size && [...stored].every((id) => current.has(id)) ? current : stored })
    window.addEventListener(DISMISSED_EVENT, reread)
    return () => window.removeEventListener(DISMISSED_EVENT, reread)
  }, [])

  const answer = useCallback(async (ticket: Ticket, text: string, sendBack?: string) => {
    if (!ticket.node) return
    await answerRun(ticket.runId, ticket.node, text, sendBack)
    await refresh()
  }, [refresh])

  const answerPermissionTicket = useCallback(async (ticket: Ticket, decision: PermissionDecision) => {
    if (!ticket.requestId) return
    await answerPermission(ticket.runId, ticket.requestId, decision)
    await refresh()
  }, [refresh])

  const answerSpendTicket = useCallback(async (ticket: Ticket, decision: SpendDecision) => {
    if (!ticket.stopId) return
    await answerSpend(ticket.runId, ticket.stopId, decision)
    await refresh()
  }, [refresh])

  usePresence(tickets.length, working)
  const mark = useLoomMarkState(records, tickets.length, working)
  const teamList = useMemo(() => [...names].map(([path, name]) => ({ path, name })), [names])
  return { records, tickets, working, mark, error, dismiss, answer, answerPermission: answerPermissionTicket, answerSpend: answerSpendTicket, refresh, teams: teamList }
}

/**
 * Approve, from anywhere a review shows outside its run (Home, a room): the review the run waits
 * on, from the shared poll, read again first when the poll hasn't seen the run yet. The same words
 * the tray's Approve sends. False when the run has no review waiting any more.
 */
export async function approveRun(runId: string): Promise<boolean> {
  const review = () => ticketsFrom(runs.snapshot.records, new Map(), new Set()).find((one) => one.kind === 'review' && one.runId === runId)
  if (!review()) await refreshRuns()
  const ticket = review()
  if (!ticket?.node) return false
  await answerRun(ticket.runId, ticket.node, APPROVAL_TEXT)
  await refreshRuns()
  return true
}

/** Tab title and tab icon carry the count, so a waiting team is visible from another tab. */
function usePresence(waiting: number, working: number) {
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\)\s+/, '')
    document.title = waiting > 0 ? `(${waiting}) ${base}` : base
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (!link) return
    const original = link.dataset.original ?? link.href
    link.dataset.original = original
    if (waiting === 0 && working === 0) { link.href = original; return }
    // Waiting on you is your turn, not something wrong: the mark's own gold for "asking", not red,
    // and its "o" mouth (LoomMark's asking pose), so the two dots differ by shape as well as hue
    // where the title's count is hidden. Blue is the live work, as everywhere; it keeps the stitch.
    const dot = waiting > 0 ? '#E9C46A' : '#6AB8FF'
    const mouth = waiting > 0
      ? '<circle cx="256" cy="362" r="26" fill="none" stroke="#E9C46A" stroke-width="30"/>'
      : '<path d="M222 354Q256 382 290 354" fill="none" stroke="#E9C46A" stroke-width="40" stroke-linecap="round"/>'
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#08080A"/><path d="M256 40H384A88 88 0 0 1 472 128V384A88 88 0 0 1 384 472H128A88 88 0 0 1 40 384V128A88 88 0 0 1 128 40Z" fill="none" stroke="#D8A93C" stroke-width="26" stroke-linecap="round" stroke-dasharray="49.28 49.28" stroke-dashoffset="24.64"/><rect x="152" y="146" width="70" height="150" rx="35" fill="#F5F3EE"/><rect x="290" y="146" width="70" height="150" rx="35" fill="#F5F3EE"/>${mouth}<circle cx="416" cy="96" r="92" fill="${dot}" stroke="#08080A" stroke-width="24"/></svg>`
    link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`
  }, [waiting, working])
  useEffect(() => () => {
    document.title = document.title.replace(/^\(\d+\)\s+/, '')
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (link?.dataset.original) link.href = link.dataset.original
  }, [])
}
