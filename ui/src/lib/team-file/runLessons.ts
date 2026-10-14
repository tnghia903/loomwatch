// What the team's own recent runs say would make it work better.
//
// checkup.ts reads the team file, so it can only say what the instructions suggest. A team's runs
// say what actually happened: the lead never handed a teammate anything, a later stage kept asking
// an earlier one for what its handover left out, an agent stopped to ask for the same permission
// run after run, an agent failed again. Each lesson is a CheckupFinding, so it is shown, fixed and
// hidden exactly like the rest, and it says how many runs it was read from.
//
// Every count comes from the run's recorded messages (lib/watch/messages.ts) and agent outcomes,
// never from what an agent said about itself (RUN_PROVENANCE_CONTRACT.md §8.2). Pure, like checkup.ts.

import type { RunRecord } from '../runs/client'
import type { RunEvent, RunProjection } from '../watch/events'
import type { TeamMessage } from '../watch/messages'
import { actsWithoutAsking } from './allow'
import { bySeverity, canUseTeamBus, mentions, type CheckupFinding, type CheckupInput } from './checkup'
import type { AgentConfig, AllowSwitch } from './types'

/** One finished run, reduced to what the lessons read. */
export interface LessonRun {
  runId: string
  /** Only a run that succeeded shows a habit; one that failed may have stopped before it could. */
  succeeded: boolean
  mode: 'team' | 'pipeline'
  entrypoint: string
  /** The agents the run started with. */
  agentIds: readonly string[]
  messages: readonly Pick<TeamMessage, 'kind' | 'from' | 'to' | 'text' | 'carried' | 'permission'>[]
  /** Agents whose part ended in failure, with why when the record says. */
  failed: ReadonlyMap<string, string | null>
  /** What each agent's app reported: tokens over all its turns (LoomWatch's handover and
      checkpoint turns included), and how full its context was after its first step, which is the
      opening cost its app pays before the work. Absent for an agent that reported nothing. */
  usage: ReadonlyMap<string, AgentRunUsage>
}

export interface AgentRunUsage {
  tokens: number | null
  opening: number | null
}

/** How many recent runs a lesson reads: enough to see a habit, few enough to still be this team. */
export const LESSON_RUNS = 5
/** A teammate left idle this many times running is not a coincidence. */
const IDLE_RUNS = 3

const PERMISSION_WORDS: Record<AllowSwitch, string> = { web: 'search the web', edits: 'change files', commands: 'run commands' }
const ALLOW_LABEL: Record<AllowSwitch, string> = { web: 'Allow web search', edits: 'Allow file changes', commands: 'Allow commands' }

/** Reduce a run, its projection and its events to what the lessons read. */
export function lessonRun(record: Pick<RunRecord, 'runId' | 'status' | 'mode' | 'entrypoint' | 'agentIds'>, projection: Pick<RunProjection, 'messages' | 'agents'>, events: readonly Pick<RunEvent, 'agentId' | 'kind' | 'payload'>[] = []): LessonRun {
  const failed = new Map<string, string | null>()
  for (const agent of projection.agents) {
    if (agent.status !== 'failed') continue
    // What its app said beats its stop reason: a turn Codex refused still ended `end_turn`.
    failed.set(agent.id, agent.error ?? agent.stopReason ?? (agent.exitCode !== null ? `its app exited with code ${agent.exitCode}` : null))
  }
  const opening = new Map<string, number>()
  for (const event of events) {
    if (event.kind === 'usage' && typeof event.payload.used === 'number' && !opening.has(event.agentId)) opening.set(event.agentId, event.payload.used)
  }
  const usage = new Map<string, AgentRunUsage>()
  for (const agent of projection.agents) {
    if (agent.tokens !== null || opening.has(agent.id)) usage.set(agent.id, { tokens: agent.tokens, opening: opening.get(agent.id) ?? null })
  }
  return { runId: record.runId, succeeded: record.status === 'succeeded', mode: record.mode, entrypoint: record.entrypoint, agentIds: record.agentIds, messages: projection.messages, failed, usage }
}

export interface AgentUsage {
  id: string
  name: string
  /** Average tokens per team run, counting runs it did not take part in as none. */
  perRun: number
  /** Its part of everything the team's agents reported. */
  share: number
  /** Typical context after its first step: what its app costs before the work. */
  opening: number | null
}

export interface TeamUsage {
  /** Runs that reported any usage. */
  runs: number
  perRun: number
  /** Most tokens first. */
  agents: AgentUsage[]
}

const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)]

/** Where the team's tokens went over its recent runs, by agent, as its apps reported them. */
export function teamUsage(runs: readonly LessonRun[], agents: readonly AgentConfig[]): TeamUsage | null {
  const reported = runs.slice(0, LESSON_RUNS).filter((run) => [...run.usage.values()].some((usage) => usage.tokens !== null))
  if (reported.length === 0) return null
  const rows = agents.filter((agent) => agent.kind !== 'operator').map((agent) => {
    const samples = reported.flatMap((run) => run.usage.get(agent.id) ?? [])
    const total = samples.reduce((sum, usage) => sum + (usage.tokens ?? 0), 0)
    const openings = samples.flatMap((usage) => usage.opening ?? [])
    return { id: agent.id, name: agent.name, total, opening: openings.length ? median(openings) : null }
  }).filter((row) => row.total > 0 || row.opening !== null)
  const teamTotal = rows.reduce((sum, row) => sum + row.total, 0)
  return {
    runs: reported.length,
    perRun: teamTotal / reported.length,
    agents: rows
      .map(({ total, ...row }) => ({ ...row, perRun: total / reported.length, share: teamTotal > 0 ? total / teamTotal : 0 }))
      .sort((a, b) => b.perRun - a.perRun),
  }
}

function firstLine(text: string, max = 110): string {
  const line = text.trim().split('\n').find((part) => part.trim())?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

export function runLessons(runs: readonly LessonRun[], { agents, edges, entrypoint, scheduled = false }: CheckupInput): CheckupFinding[] {
  const recent = runs.slice(0, LESSON_RUNS)
  const findings: CheckupFinding[] = []
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  const lead = entrypoint ? byId.get(entrypoint) : undefined
  const ranIn = (id: string) => recent.filter((run) => run.agentIds.includes(id))
  const work = (message: LessonRun['messages'][number]) => !message.carried && (message.kind === 'dispatch' || message.kind === 'ask' || message.kind === 'handoff')

  // ── A lead that never hands a teammate anything. Only today's team mode with today's lead. ──
  if (edges.length === 0 && lead && lead.kind !== 'operator' && canUseTeamBus(lead)) {
    for (const teammate of agents) {
      if (teammate.id === lead.id || teammate.kind === 'operator' || mentions(lead.role, teammate.name)) continue
      const runsTogether = recent.filter((run) => run.succeeded && run.mode === 'team' && run.entrypoint === lead.id && run.agentIds.includes(teammate.id))
      if (runsTogether.length < IDLE_RUNS) continue
      if (runsTogether.some((run) => run.messages.some((message) => work(message) && message.to === teammate.id))) continue
      findings.push({
        id: `idle-teammate:${teammate.id}`, rule: 'idle-teammate', severity: 'improve', agentId: lead.id, agentIds: [lead.id, teammate.id],
        learned: runsTogether.length,
        title: `${lead.name} never gave ${teammate.name} any work`,
        why: `${lead.name} did the whole job itself. Tell it when ${teammate.name}'s part is needed, or remove ${teammate.name} to keep the team simple.`,
        fix: { label: `Tell ${lead.name} to use ${teammate.name}`, change: { kind: 'append-role', agentId: lead.id, text: `When the request needs ${teammate.name}'s part, hand it to ${teammate.name} instead of doing it yourself.` } },
      })
    }
  }

  // ── A later stage that keeps asking an earlier one for what its handover left out. ──
  if (edges.length > 0) {
    const asked = new Map<string, { from: string; to: string; questions: string[]; runs: Set<string> }>()
    for (const run of recent.filter((candidate) => candidate.succeeded && candidate.mode === 'pipeline')) {
      for (const message of run.messages) {
        if (message.carried || message.kind !== 'ask' || !message.from || !message.to || !byId.has(message.from) || !byId.has(message.to)) continue
        const key = `${message.from}>${message.to}`
        const entry = asked.get(key) ?? { from: message.from, to: message.to, questions: [], runs: new Set<string>() }
        entry.questions.push(firstLine(message.text))
        entry.runs.add(run.runId)
        asked.set(key, entry)
      }
    }
    for (const { from, to, questions, runs: inRuns } of asked.values()) {
      const asker = byId.get(from)
      const holder = byId.get(to)
      if (!asker || !holder || questions.length < 3 || inRuns.size < 2 || mentions(holder.role, asker.name)) continue
      // The question asked most often says best what the handover lacks; ties go to the latest.
      const examples = [...new Set(questions.filter(Boolean))]
        .sort((a, b) => questions.filter((q) => q === b).length - questions.filter((q) => q === a).length || questions.lastIndexOf(b) - questions.lastIndexOf(a))
        .slice(0, 2)
      findings.push({
        id: `asked-again:${to}+${from}`, rule: 'asked-again', severity: 'improve', agentId: to, agentIds: [to, from],
        learned: inRuns.size,
        title: `${asker.name} keeps asking ${holder.name} for more`,
        why: `${asker.name} asked ${holder.name} ${questions.length} questions${examples[0] ? `, such as “${examples[0]}”` : ''}. What it asks for belongs in ${holder.name}'s handover.`,
        fix: {
          label: 'Put it in the handover',
          change: { kind: 'append-role', agentId: to, text: `${asker.name} works from your handover and has had to ask you for more${examples.length ? `, such as: ${examples.map((question) => `“${question}”`).join('; ')}` : ''}. Put that kind of detail in your handover from the start.` },
        },
      })
    }
  }

  // ── The same permission, asked for run after run. Same id as checkup.ts's guess: it replaces it. ──
  for (const agent of agents) {
    if (agent.kind === 'operator' || actsWithoutAsking(agent)) continue
    const runs = ranIn(agent.id)
    for (const key of ['web', 'edits', 'commands'] as AllowSwitch[]) {
      if (agent.allow?.[key]) continue
      const asks = runs.map((run) => run.messages.filter((message) => message.kind === 'permission' && message.from === agent.id && message.permission?.switch === key))
      const inRuns = asks.filter((list) => list.length > 0).length
      if (inRuns < 2) continue
      const unanswered = asks.flat().filter((message) => message.permission?.outcome === 'timed_out' || message.permission?.outcome === 'deny').length
      findings.push({
        id: `needs-${key}:${agent.id}`, rule: key === 'web' ? 'needs-web' : key === 'edits' ? 'needs-edits' : 'needs-commands',
        severity: scheduled ? 'fix' : 'improve', agentId: agent.id, agentIds: [agent.id], learned: runs.length,
        title: `${agent.name} asked to ${PERMISSION_WORDS[key]} in ${inRuns} of ${runs.length} runs`,
        why: `Each time, the run waited for your answer${unanswered ? `, and ${unanswered === 1 ? 'one was' : `${unanswered} were`} declined or not answered` : ''}. Allow it here if you trust ${agent.name} with it.`,
        fix: { label: ALLOW_LABEL[key], change: { kind: 'allow', agentId: agent.id, key } },
      })
    }
  }

  // ── An agent that fails again. Nothing to fix in one click: its panel is where to look. ──
  for (const agent of agents) {
    if (agent.kind === 'operator') continue
    const runs = ranIn(agent.id)
    const failures = runs.filter((run) => run.failed.has(agent.id))
    if (failures.length < 2) continue
    const why = failures[0].failed.get(agent.id)
    findings.push({
      id: `keeps-failing:${agent.id}`, rule: 'keeps-failing', severity: 'fix', agentId: agent.id, agentIds: [agent.id], learned: runs.length,
      title: `${agent.name} failed in ${failures.length} of ${runs.length} runs`,
      why: `${why ? `Last time: ${firstLine(why, 140)}. ` : ''}Check its AI app and model first, then its instructions.`,
    })
  }

  return findings
}

/** The checkup and the lessons together: a lesson replaces the guess it confirms, most urgent first. */
export function mergeFindings(guessed: readonly CheckupFinding[], learned: readonly CheckupFinding[]): CheckupFinding[] {
  const ids = new Set(learned.map((finding) => finding.id))
  return [...learned, ...guessed.filter((finding) => !ids.has(finding.id))].sort(bySeverity)
}
