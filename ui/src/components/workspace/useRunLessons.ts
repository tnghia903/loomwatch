import { useEffect, useState } from 'react'

import { fetchRuns, type RunRecord } from '../../lib/runs/client'
import { LESSON_RUNS, lessonRun, type LessonRun } from '../../lib/team-file/runLessons'
import { appendEvents, parseEvents, projectRun, type RunEvent } from '../../lib/watch/events'
import { eventsQuery, readArchive } from '../../lib/watch/useSessionEvents'
import { sameTeamFile } from '../ask/useAskActions'

/** A finished run never changes, so each is read and projected once per page load. */
const read = new Map<string, Promise<LessonRun | null>>()
/** Past this many events a run is left out rather than read for seconds in the background. */
const MAX_EVENTS = 10_000
const PAGE = 500
/** How often the run list is re-read, so a run that just finished counts without a reload. */
const POLL_MS = 30_000

async function readRun(record: RunRecord): Promise<LessonRun | null> {
  // The record counts a finished run's events, so a run too long to read is known before reading.
  if (record.eventCount !== null && record.eventCount > MAX_EVENTS) return null
  let events: RunEvent[] = []
  while (events.length < MAX_EVENTS) {
    const query = eventsQuery(record.sessionId, events.at(-1)?.seq ?? -1, PAGE)
    const page = parseEvents(await readArchive(`/api/session/events?${query}`))
    events = appendEvents(events, page, record.sessionId)
    if (page.length < PAGE) return lessonRun(record, projectRun(events, Infinity, { responder: record.responder, status: record.status }), events)
  }
  return null
}

/** One finished run reduced to what the lessons read, read and projected once per page load. */
export function lesson(record: RunRecord): Promise<LessonRun | null> {
  let pending = read.get(record.runId)
  if (!pending) {
    // An archive that cannot be read (no database, a gap) costs this run its lessons, nothing more.
    pending = readRun(record).catch(() => null)
    read.set(record.runId, pending)
  }
  return pending
}

/**
 * Whole-team runs of this team that ran to an end, newest first: a cancelled run stopped before it
 * could show a habit, and a one-agent turn or a follow-up that started part-way never asked the
 * whole team for anything.
 */
export function lessonRecords(records: readonly RunRecord[], teamPath: string): RunRecord[] {
  return records
    .filter((record) => sameTeamFile(teamPath, record.teamPath) && (record.status === 'succeeded' || record.status === 'failed') && !record.onlyAgent && !record.startAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, LESSON_RUNS)
}

/** The team's recent finished runs, read for the checkup's lessons (lib/team-file/runLessons.ts). */
export function useRunLessons(teamPath: string | null): LessonRun[] {
  const [state, setState] = useState<{ teamPath: string | null; runs: LessonRun[] }>({ teamPath: null, runs: [] })
  useEffect(() => {
    if (!teamPath) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let shown = ''
    const tick = async () => {
      try {
        const records = lessonRecords(await fetchRuns(controller.signal), teamPath)
        const runs = (await Promise.all(records.map(lesson))).filter((run): run is LessonRun => run !== null)
        const key = runs.map((run) => run.runId).join()
        if (!controller.signal.aborted && key !== shown) {
          shown = key
          setState({ teamPath, runs })
        }
      } catch { /* the run list is unavailable: keep what was read */ }
      if (!controller.signal.aborted) timer = setTimeout(() => void tick(), POLL_MS)
    }
    void tick()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [teamPath])
  return state.teamPath === teamPath ? state.runs : []
}
