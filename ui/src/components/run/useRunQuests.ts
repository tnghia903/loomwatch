import { useEffect, useMemo, useRef, useState } from 'react'

import { questFor, type Quest, type QuestItem } from '../../lib/quests/catalog'
import { BOBBIN_LINE, questsEarned, wholeCraft, type Award } from '../../lib/quests/rules'
import { earnItem, fetchWardrobe, useWardrobe } from '../../lib/quests/wardrobe'
import { fetchRuns, type RunRecord } from '../../lib/runs/client'
import { fetchTeamFile } from '../../lib/team-file/client'
import { benchChatOwner, fetchJobs } from '../../lib/library/jobs'
import { filledTeam } from '../../lib/team-file/myAgents'
import { LESSON_RUNS, lessonRun } from '../../lib/team-file/runLessons'
import type { AgentConfig } from '../../lib/team-file/types'
import type { RunProjection } from '../../lib/watch/events'
import { sameTeamFile } from '../ask/useAskActions'
import { lesson } from '../workspace/useRunLessons'

/** What a run earned, as its receipt says it. */
export interface RunEarned {
  quest: Quest
  line: string
  agentId: string | null
}

const ENDED = new Set(['succeeded', 'failed', 'cancelled'])

/** The saved agents with a test bench run that finished before `before`. */
export function benchedBefore(records: readonly RunRecord[], before: string): Set<string> {
  return new Set(records.flatMap((record) => {
    const owner = benchChatOwner(record.teamPath)
    return owner && record.status === 'succeeded' && record.createdAt < before ? [owner] : []
  }))
}

/** The same team's whole-team runs that ended before `record`, newest first. */
export function earlierRecords(records: readonly RunRecord[], record: RunRecord): RunRecord[] {
  return records
    .filter((other) => other.runId !== record.runId && sameTeamFile(record.teamPath, other.teamPath) && other.createdAt < record.createdAt && (other.status === 'succeeded' || other.status === 'failed') && !other.onlyAgent && !other.startAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, LESSON_RUNS)
}

/**
 * The agents of the team file exactly as `record` ran it, or null when that is no longer on disk.
 *
 * A run is judged only against the settings it ran with: a Done when, a folder, a key or a bench
 * link added after it must not earn for a run that never had it, and the first earn is permanent.
 * The daemon records the digest of the bytes each run executed (`teamRevision`), so while the team
 * file's revision is still that one it holds exactly those settings, and once it has changed the
 * run is not judged at all. Keeping a copy of every run's team file would let those runs be judged
 * too, but needs a second store and a route to read it back; one digest compared is the smallest
 * change that is never wrong. It costs only runs nobody can judge honestly any more: a run from
 * before the digest was kept, or one whose team was edited since. The editor's copy of the team is
 * not used either: it can hold edits nobody has saved, let alone run.
 */
export async function agentsRunWith(record: Pick<RunRecord, 'teamPath' | 'teamRevision'>): Promise<AgentConfig[] | null> {
  if (!record.teamRevision) return null
  const [file, jobs] = await Promise.all([fetchTeamFile(record.teamPath), fetchJobs().then((list) => list?.jobs ?? [], () => [])])
  if (file.revision !== record.teamRevision) return null
  // Its agents as My agents has them (ADR 0094): what changed there since is as near as is known.
  return filledTeam(file.yaml, jobs)?.agents ?? []
}

/**
 * The quests a finished run earned (lib/quests), put in the wardrobe the first time, and what its
 * receipt shows: only items this run was the first to earn, so a later run never repeats them.
 * Read once the run's record is complete, so nothing is judged on half of it. A run looked at again
 * later is judged the same way, against the runs before it and the team file it ran, so a run that
 * earned something before the wardrobe existed earns it when its receipt is opened, as long as its
 * team file has not changed since (`agentsRunWith`).
 */
export function useRunQuests({ record, projection, phase }: {
  record: RunRecord | null
  projection: Pick<RunProjection, 'agents' | 'evidence' | 'messages' | 'checks' | 'coverage'>
  phase: string
}): RunEarned[] {
  const { wardrobe } = useWardrobe()
  const [awards, setAwards] = useState<{ runId: string; list: Award[] } | null>(null)
  const judged = useRef<string | null>(null)
  const ready = Boolean(record && ENDED.has(record.status) && ENDED.has(phase === 'partial' ? 'failed' : phase) && projection.coverage.agents.level === 'complete')
  // The latest of what is judged, read when the judging starts: the record is a new object each
  // time the run list is read again, and that must not restart it.
  const latest = useRef({ record, projection, phase })
  useEffect(() => { latest.current = { record, projection, phase } })
  const runId = record?.runId ?? null

  useEffect(() => {
    const { record, projection, phase } = latest.current
    if (!ready || !record || record.runId !== runId || judged.current === record.runId) return
    judged.current = record.runId
    let shown = true
    void (async () => {
      try {
        const agents = await agentsRunWith(record)
        if (agents === null) {
          if (shown) setAwards({ runId: record.runId, list: [] })
          return
        }
        const records = await fetchRuns()
        const earlier = (await Promise.all(earlierRecords(records, record).map(lesson))).flatMap((run) => (run ? [run] : []))
        const list = questsEarned({
          run: record,
          succeeded: phase === 'succeeded',
          agents,
          projection,
          current: lessonRun(record, projection),
          earlier,
          benched: benchedBefore(records, record.createdAt),
        })
        if (shown) setAwards({ runId: record.runId, list })
        if (list.length === 0) return
        const held = (await fetchWardrobe()) ?? null
        if (held === null) return
        const earn = (item: QuestItem, agentId: string | null) => earnItem(item, { runId: record.runId, teamPath: record.teamPath, agentId })
        for (const award of list) if (!held[award.item]) await earn(award.item, award.agentId)
        if (!held.bobbin && wholeCraft([...Object.keys(held), ...list.map((award) => award.item)])) await earn('bobbin', null)
      } catch {
        // The run list or the wardrobe is out of reach: this run earns nothing now, and is judged
        // again the next time its receipt is opened.
        judged.current = null
      }
    })()
    // What was earned is still put in the wardrobe after the receipt closes; only showing it stops.
    return () => { shown = false }
  }, [ready, runId])

  return useMemo(() => {
    if (!record) return []
    const list = awards?.runId === record.runId ? awards.list : []
    return Object.entries(wardrobe).flatMap(([item, entry]): RunEarned[] => {
      const quest = questFor(item)
      if (!quest || entry?.runId !== record.runId) return []
      const award = list.find((candidate) => candidate.item === item)
      return [{ quest, agentId: award?.agentId ?? entry.agentId ?? null, line: award?.line ?? (item === 'bobbin' ? BOBBIN_LINE : quest.earnedWhen) }]
    })
  }, [record, awards, wardrobe])
}
