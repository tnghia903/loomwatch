import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { answerRun, fetchRuns, type RunRecord } from '../runs/client'
import { teamDisplayName } from '../team-file/client'
import { useTeamList } from '../team-file/useTeamList'
import { ticketsFrom, type Ticket } from './needsYou'

const DISMISSED_KEY = 'loomwatch.needsYou.dismissed'

function loadDismissed(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as string[]) } catch { return new Set() }
}

/**
 * Polls the run registry for the needs-you tray, and shows the result where the operator looks
 * when they are not looking at LoomWatch: the tab title counts what waits on them, and the tab
 * icon carries a dot — red when something needs them, blue while a team is working.
 */
export function useNeedsYou() {
  const [records, setRecords] = useState<RunRecord[]>([])
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissed)
  const [error, setError] = useState<string | null>(null)
  const { teams } = useTeamList()
  const generation = useRef(0)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const mine = ++generation.current
    try {
      const runs = await fetchRuns(signal)
      if (signal?.aborted || mine !== generation.current) return
      setRecords(runs)
      setError(null)
    } catch (caught) {
      if (!signal?.aborted) setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    // Keeps polling in a background tab, more slowly: the tab title and icon exist for exactly
    // the moment the operator is looking somewhere else.
    const tick = async () => {
      await refresh(controller.signal)
      if (!controller.signal.aborted) timer = setTimeout(() => void tick(), document.hidden ? 15000 : 5000)
    }
    void tick()
    const wake = () => { if (!document.hidden) void refresh(controller.signal) }
    document.addEventListener('visibilitychange', wake)
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', wake) }
  }, [refresh])

  const names = useMemo(() => new Map((teams ?? []).map((team) => [team.path, teamDisplayName(team)])), [teams])
  const tickets = useMemo(() => ticketsFrom(records, names, dismissed), [records, names, dismissed])
  const working = useMemo(() => records.filter((record) => (record.status === 'running' || record.status === 'starting') && !record.waitingOn).length, [records])

  const dismiss = useCallback((runId: string) => {
    setDismissed((current) => {
      const next = new Set(current)
      next.add(runId)
      try { localStorage.setItem(DISMISSED_KEY, JSON.stringify([...next].slice(-200))) } catch { /* private mode */ }
      return next
    })
  }, [])

  const answer = useCallback(async (ticket: Ticket, text: string, sendBack?: string) => {
    if (!ticket.node) return
    await answerRun(ticket.runId, ticket.node, text, sendBack)
    await refresh()
  }, [refresh])

  usePresence(tickets.length, working)
  const teamList = useMemo(() => [...names].map(([path, name]) => ({ path, name })), [names])
  return { records, tickets, working, error, dismiss, answer, refresh, teams: teamList }
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
    const dot = waiting > 0 ? '#F2635C' : '#6AB8FF'
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#08080A"/><g fill="none" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"><path d="M96 332 156 180 216 332 276 180 336 332 396 180" stroke="#E9C46A"/><path d="M96 180 156 332 216 180 276 332 336 180 396 332" stroke="#E9C46A" opacity=".34"/></g><circle cx="416" cy="96" r="92" fill="${dot}" stroke="#08080A" stroke-width="24"/></svg>`
    link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`
  }, [waiting, working])
  useEffect(() => () => {
    document.title = document.title.replace(/^\(\d+\)\s+/, '')
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (link?.dataset.original) link.href = link.dataset.original
  }, [])
}
