import { useCallback, useMemo, useState } from 'react'

import { appendToRole, checkup, type CheckupFinding, type CheckupInput } from '../../lib/team-file/checkup'
import { mergeFindings, runLessons, teamUsage, type LessonRun, type TeamUsage } from '../../lib/team-file/runLessons'
import type { AllowSwitch } from '../../lib/team-file/types'
import type { useTeamDocument } from '../../lib/team-file/useTeamDocument'

type TeamDocumentController = ReturnType<typeof useTeamDocument>

/** One agent's line of the team's usage, in the shape the agent panel takes. */
export function teamUsageFor(usage: TeamUsage | null, agentId: string) {
  const agent = usage?.agents.find((candidate) => candidate.id === agentId)
  return usage && agent ? { agent, runs: usage.runs, alone: usage.agents.length === 1 } : undefined
}

/** Per-browser, per-team: which suggestions the operator said they do not need. */
const HIDDEN_KEY = 'loomwatch.checkup.hidden'

function readHidden(): Record<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(HIDDEN_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string[]> : {}
  } catch {
    return {}
  }
}

function writeHidden(hidden: Record<string, string[]>) {
  try {
    window.localStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden))
  } catch { /* private window or blocked storage: the hide lasts until reload */ }
}

export interface TeamCheckup {
  /** Shown findings, most urgent first. */
  findings: CheckupFinding[]
  /** How many the operator hid for this team. */
  hiddenCount: number
  /** Where the team's tokens went in its recent runs; null before any reported usage. */
  usage: TeamUsage | null
  forAgent: (agentId: string) => CheckupFinding[]
  apply: (finding: CheckupFinding) => void
  dismiss: (finding: CheckupFinding) => void
  restore: () => void
}

/**
 * The team checkup over the open document and what its recent runs taught (`lessons`), with fixes
 * applied through the document's own edits, so each is one undo step and is saved with ⌘S like any
 * other change.
 */
export function useTeamCheckup(doc: TeamDocumentController, responder: string | null, announce: (text: string) => void, lessons: readonly LessonRun[] = []): TeamCheckup {
  const teamKey = doc.path ?? ''
  const [hidden, setHidden] = useState(readHidden)
  const input = useMemo<CheckupInput>(() => ({
    agents: doc.nodes.map((node) => node.data.agent),
    edges: doc.edges.map((edge) => ({ from: edge.source, to: edge.target })),
    entrypoint: doc.entrypoint,
    responder,
    scheduled: Boolean(doc.teamSchedule && doc.teamSchedule.enabled !== false),
  }), [doc.nodes, doc.edges, doc.entrypoint, responder, doc.teamSchedule])
  const all = useMemo(() => mergeFindings(checkup(input), runLessons(lessons, input)), [input, lessons])
  const usage = useMemo(() => teamUsage(lessons, input.agents), [lessons, input.agents])
  const hiddenHere = useMemo(() => new Set(hidden[teamKey] ?? []), [hidden, teamKey])
  const findings = useMemo(() => all.filter((finding) => !hiddenHere.has(finding.id)), [all, hiddenHere])
  const hiddenCount = all.length - findings.length

  const forAgent = useCallback((agentId: string) => findings.filter((finding) => finding.agentIds.includes(agentId)), [findings])

  const { nodes, updateAgentAllow, renameAgent } = doc
  const apply = useCallback((finding: CheckupFinding) => {
    const change = finding.fix?.change
    if (!change) return
    const agent = nodes.find((node) => node.id === change.agentId)?.data.agent
    if (change.kind === 'allow') updateAgentAllow(change.agentId, change.key, true)
    else if (change.kind === 'append-role') renameAgent(change.agentId, 'role', appendToRole(agent?.role ?? '', change.text))
    else {
      renameAgent(change.agentId, 'role', change.text)
      for (const [key, on] of Object.entries(change.allow ?? {})) if (on && !agent?.allow?.[key as AllowSwitch]) updateAgentAllow(change.agentId, key as AllowSwitch, true)
    }
    announce(`${finding.fix?.label}: done for ${agent?.name ?? change.agentId}. Save the team to keep this change.`)
  }, [nodes, updateAgentAllow, renameAgent, announce])

  const dismiss = useCallback((finding: CheckupFinding) => {
    setHidden((current) => {
      const next = { ...current, [teamKey]: [...new Set([...(current[teamKey] ?? []), finding.id])] }
      writeHidden(next)
      return next
    })
    announce('Suggestion hidden for this team.')
  }, [teamKey, announce])

  const restore = useCallback(() => {
    setHidden((current) => {
      const { [teamKey]: _restored, ...rest } = current
      writeHidden(rest)
      return rest
    })
  }, [teamKey])

  return { findings, hiddenCount, usage, forAgent, apply, dismiss, restore }
}
