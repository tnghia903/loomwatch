import { OUTWARD_APP_TOOLS, outwardCalls } from '../library/observed'
import type { AgentRuntime } from '../runs/graph'
import type { AgentAllow, AllowSwitch } from '../team-file/types'
import type { Evidence, RunPhase, RunProjection } from '../watch/events'
import { failuresOf, readPhrase, workCount } from './reads'
import { describeEvidence } from './weft'

/**
 * The run receipt: a printed account of one run, in the order a person checks it.
 *
 * What was asked, who did what, what failed and what happened instead, then what is worth a second
 * look. It says the same facts the trace holds, once and in plain words, and every line carries the
 * evidence id it came from so an expert can open the record behind it. Nothing here is inferred
 * from an agent's prose: a skill counts as used only when the stream shows it opened. Lines report
 * outcomes, not calls (lib/story/reads.ts): a failed read is a failure only when no read of the
 * same thing succeeded, and every count is of things, not of the calls it took to reach them.
 */
export type ReceiptTone = 'ok' | 'bad' | 'warn' | 'wait'

export interface ReceiptLine {
  tone: ReceiptTone
  text: string
  agentId?: string
  evidenceId?: string
  /** A refusal one of the agent's switches covers (ADR 0037), so the line can offer it. */
  allow?: AllowSwitch
  /** That switch is on now, so the next run will not be refused. */
  allowed?: boolean
  /** Explains other lines rather than reporting anything of its own, so it is not a finding. */
  aside?: boolean
}

export interface Receipt {
  heading: string
  asked: string
  took: string
  team: string
  ranOn: string
  lines: ReceiptLine[]
  checks: ReceiptLine[]
}

export interface ReceiptAgent {
  id: string
  name: string
  operator: boolean
  runtime?: Pick<AgentRuntime, 'status'> | null
  /** Its switches as they are now, which may be newer than the run. */
  allow?: AgentAllow
}

export interface ReceiptInput {
  attempt: number
  prompt: string
  phase: RunPhase
  elapsed: string
  agents: readonly ReceiptAgent[]
  projection: RunProjection
  evidenceByAgent: ReadonlyMap<string, readonly Evidence[]>
  /** Agent id → the app it ran on ("Claude Code"). */
  harnessLabels: ReadonlyMap<string, string>
  answered: boolean
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

function workSummary(items: readonly Evidence[]): string {
  const { skills, read: count, searches, changed, commands } = workCount(items)
  const read = readPhrase(count)
  const parts = [
    skills && `used ${plural(skills, 'skill')}`,
    read && `read ${read}`,
    searches && `ran ${plural(searches, 'search', 'searches')}`,
    changed && `changed ${plural(changed, 'file')}`,
    commands && `ran ${plural(commands, 'command')}`,
  ].filter(Boolean)
  return parts.length ? ` · ${parts.join(', ')}` : ''
}

/**
 * The switch that covers a refused permission request, from the kind its app gave the tool call:
 * the same mapping the daemon decides by (`permissions.rs`). `null` for a kind no switch covers.
 */
export function switchForRequest(item: Pick<Evidence, 'rawInput'>): AllowSwitch | null {
  const request = item.rawInput as { toolCall?: { kind?: unknown } } | null
  const kind = request?.toolCall?.kind
  return kind === 'fetch' ? 'web' : kind === 'edit' ? 'edits' : kind === 'execute' ? 'commands' : null
}

const REFUSED: Record<AllowSwitch, string> = { web: 'search the web', edits: 'edit files', commands: 'run commands' }

/** Refused requests as the agent's lines: one per switch, so ten refused searches read as one. */
function refusalLines(agent: ReceiptAgent, items: readonly Evidence[], carriedOn: boolean): ReceiptLine[] {
  const refused = items.filter((item) => item.kind === 'permission' && item.status === 'rejected')
  const groups = new Map<AllowSwitch | null, Evidence[]>()
  for (const item of refused) {
    const key = switchForRequest(item)
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  const carried = carriedOn ? ', and carried on without it' : ''
  const lines: ReceiptLine[] = []
  for (const [key, group] of groups) {
    const evidenceId = group[0].id
    const times = group.length > 1 ? ` (asked ${group.length} times)` : ''
    if (key === null) {
      for (const item of group.slice(0, 3)) lines.push({ tone: 'bad', text: `${describeEvidence(agent.name, item).replace(/\.$/, '')}${carried}`, agentId: agent.id, evidenceId: item.id })
    } else if (key === 'edits' && agent.allow?.edits) {
      // Edits are on, so what was refused was a change outside its own folder: no switch covers it.
      lines.push({ tone: 'bad', text: `${agent.name} wasn’t allowed to edit files outside its own folder${times}${carried}`, agentId: agent.id, evidenceId })
    } else {
      lines.push({ tone: 'bad', text: `${agent.name} wasn’t allowed to ${REFUSED[key]}${times}${carried}`, agentId: agent.id, evidenceId, allow: key, allowed: agent.allow?.[key] === true })
    }
  }
  return lines
}

const PHASE_HEADING: Partial<Record<RunPhase, string>> = {
  succeeded: 'Finished',
  partial: 'Finished with gaps',
  failed: 'Stopped with a problem',
  cancelled: 'Stopped by you',
}

export function buildReceipt(input: ReceiptInput): Receipt {
  const projected = new Map(input.projection.agents.map((agent) => [agent.id, agent]))
  const lines: ReceiptLine[] = []
  const checks: ReceiptLine[] = []
  // A receipt is only printed for a run that is over, so nobody on it is "still working" or
  // "waiting": whoever had not finished was stopped with the run.
  const terminal = ['succeeded', 'partial', 'failed', 'cancelled'].includes(input.phase)
  const stoppedByYou = input.phase === 'cancelled'
  let anyRefused = false
  for (const agent of input.agents) {
    if (agent.operator) {
      const status = agent.runtime?.status
      if (status === 'succeeded') lines.push({ tone: 'ok', text: 'You gave your decision', agentId: agent.id })
      else if ((status === 'waiting' || status === 'stopped') && terminal) lines.push({ tone: 'bad', text: stoppedByYou ? 'You stopped the run before giving your decision' : 'The run ended before your decision', agentId: agent.id })
      else if (status === 'waiting') lines.push({ tone: 'wait', text: 'Waiting for your decision', agentId: agent.id })
      continue
    }
    const run = projected.get(agent.id)
    const items = input.evidenceByAgent.get(agent.id) ?? []
    if (!run) { lines.push({ tone: 'wait', text: `${agent.name} didn’t run`, agentId: agent.id }); continue }
    // The cards' status first: it is corrected from the run record (a stage that handed over and
    // was kept alive is done, though its process was still open), and every surface says the same.
    const status = agent.runtime?.status ?? run.status
    if (status === 'succeeded') lines.push({ tone: 'ok', text: `${agent.name} finished${workSummary(items)}`, agentId: agent.id })
    else if (status === 'failed' || status === 'stopped' || status === 'unavailable') {
      const why = run.stopReason ? ` (${run.stopReason.replace(/_/g, ' ')})` : run.exitCode !== null ? ` (exit code ${run.exitCode})` : ''
      lines.push({ tone: 'bad', text: !why && stoppedByYou ? `${agent.name} was stopped before it finished` : `${agent.name} stopped${why}`, agentId: agent.id })
    } else if (terminal) lines.push({ tone: 'bad', text: stoppedByYou ? `${agent.name} was stopped before it finished` : `${agent.name} didn’t finish`, agentId: agent.id })
    else lines.push({ tone: 'wait', text: `${agent.name} is still working`, agentId: agent.id })

    // Failures say what happened instead, so the reader knows whether the result is affected. A
    // failed read that another read made up for (a folder read as a file, then the files in it) is
    // not one. Refused permission requests are told apart below, by what the agent was not allowed to do.
    const failed = failuresOf(items)
    for (const item of failed.slice(0, 3)) {
      const sentence = describeEvidence(agent.name, item).replace(/\.$/, '')
      lines.push({ tone: 'bad', text: `${sentence}${run.status === 'succeeded' ? ', and carried on without it' : ''}`, agentId: agent.id, evidenceId: item.id })
    }
    if (failed.length > 3) lines.push({ tone: 'bad', text: `…and ${plural(failed.length - 3, 'more failed call')} from ${agent.name}`, agentId: agent.id })
    const refusals = refusalLines(agent, items, run.status === 'succeeded')
    lines.push(...refusals)
    anyRefused ||= refusals.length > 0
    // Its app ended the turn at a decline, so the reply was finished on LoomWatch's request to
    // carry on (ADR 0046). That explains the turn; it is not a finding of its own.
    if (run.resumedTurns) {
      const app = input.harnessLabels.get(agent.id) ?? 'Its app'
      const times = run.resumedTurns > 1 ? ` (${run.resumedTurns} times)` : ''
      checks.push({ tone: 'warn', text: `${app} ends ${agent.name}’s turn when a request is declined, so LoomWatch asked ${agent.name} to carry on without it${times}`, agentId: agent.id, aside: true })
    }

    for (const skill of run.requiredSkills ?? []) {
      if (skill.state !== 'opened') checks.push({ tone: 'warn', text: `${agent.name} was given the skill “${skill.name}” but the record never shows it opened`, agentId: agent.id })
    }
    if (run.openCalls > 0) checks.push({ tone: 'warn', text: `${plural(run.openCalls, 'call')} from ${agent.name} never reported back`, agentId: agent.id })
    // A tool that reaches past the run and ran without asking (ADR 0044): the call shows what it sent.
    for (const [tool, calls] of outwardCalls(items)) {
      checks.push({ tone: 'bad', text: `${agent.name} used ${tool}, which ${OUTWARD_APP_TOOLS[tool]}, without asking you${calls.length > 1 ? ` (${calls.length} times)` : ''}`, agentId: agent.id, evidenceId: calls[0].id })
    }
  }
  for (const alert of input.projection.attention) {
    checks.push({ tone: 'warn', text: alert.message, agentId: alert.agentId, evidenceId: alert.evidenceId })
  }
  if (anyRefused) checks.push({ tone: 'warn', text: 'What an agent isn’t allowed to do waits for your answer during a run. Requests you denied, or that nobody answered in time, were declined. Change what each agent may do in its panel in Build.', aside: true })
  if (terminal && !input.answered) checks.push({ tone: 'bad', text: 'The run ended without an answer' })
  const gaps = Object.entries(input.projection.coverage).filter(([, value]) => value.level !== 'complete' && value.reason !== 'none_recorded')
  if (gaps.length) checks.push({ tone: 'warn', text: `Not everything was recorded: ${gaps.map(([key]) => key).join(', ')}` })

  const apps = [...new Set(input.agents.filter((agent) => !agent.operator).map((agent) => input.harnessLabels.get(agent.id)).filter(Boolean))]
  const helpers = input.agents.filter((agent) => !agent.operator)
  const operator = input.agents.some((agent) => agent.operator)
  return {
    heading: `Run ${input.attempt} · ${PHASE_HEADING[input.phase] ?? 'In progress'}`,
    asked: input.prompt.trim() || 'No request was recorded',
    took: input.elapsed,
    team: `${plural(helpers.length, 'helper')}${operator ? ' + your review' : ''}`,
    ranOn: apps.length ? apps.join(', ') : 'Not recorded',
    lines,
    checks,
  }
}

const MARK: Record<ReceiptTone, string> = { ok: '✓', bad: '✗', warn: '!', wait: '…' }

/** The receipt as Markdown, for a pull request, a ticket or a chat. */
export function receiptMarkdown(receipt: Receipt): string {
  const out = [
    `### ${receipt.heading}`,
    '',
    `- **Asked:** ${receipt.asked.split('\n')[0]}`,
    `- **Team:** ${receipt.team}`,
    `- **Took:** ${receipt.took}`,
    `- **Ran on:** ${receipt.ranOn}`,
    '',
    ...receipt.lines.map((line) => `- ${MARK[line.tone]} ${line.text}`),
  ]
  if (receipt.checks.length) out.push('', '**Worth a look**', ...receipt.checks.map((line) => `- ${line.text}`))
  return out.join('\n')
}

export { MARK as RECEIPT_MARK }
