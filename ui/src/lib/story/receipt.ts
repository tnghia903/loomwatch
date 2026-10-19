import { outwardCalls } from '../library/observed'
import type { RunSpend } from '../runs/client'
import type { AgentRuntime } from '../runs/graph'
import { spendNote } from '../runs/spend'
import type { AgentAllow, AllowSwitch } from '../team-file/types'
import type { Evidence, RunPhase, RunProjection } from '../watch/events'
import { formatTokens, type TokenSummary, type TurnPurpose, costWords } from '../watch/usage'
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

/** How the run ended, stamped on the slip: its word, in the tone of the slip's own marks. */
export interface ReceiptOutcome {
  word: string
  tone: ReceiptTone
}

export interface Receipt {
  /** "Run 8". */
  run: string
  outcome: ReceiptOutcome
  /** When the run's record ends (ISO), for the stamp's date; `null` when nothing was recorded. */
  endedAt: string | null
  asked: string
  took: string
  team: string
  ranOn: string
  /** `null` until the run's evidence is all in, and for a run that reported no tokens. */
  tokens: ReceiptTokens | null
  lines: ReceiptLine[]
  checks: ReceiptLine[]
}

export interface ReceiptTokenRow {
  label: string
  /** "~2.25M": three figures, `~` when part of it was worked out rather than reported. */
  value: string
  /** "2,245,301 tokens", for the hover. */
  exact: string
}

/** What the run's model calls came to (lib/watch/usage.ts): one line, and its breakdown. */
export interface ReceiptTokens extends ReceiptTokenRow {
  /** Share of prompt tokens read back from a cache, "89% cached"; `null` when none were split. */
  cached: string | null
  agents: ReceiptTokenRow[]
  purposes: ReceiptTokenRow[]
  /** Why a count carries `~`, when one does. */
  estimate: string | null
  /** What OpenRouter charged for the run, "$0.0123", or "at least $0.0123" when a turn's cost is
      unknown; `null` when no turn's cost is known. */
  cost: string | null
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
  /** Agent id → the model it ran on ("Claude Opus 5.5"). */
  harnessLabels: ReadonlyMap<string, string>
  answered: boolean
  /** What the run spent and may spend (ADR 0068): money added at a stop, and a stop at the limit. */
  spend?: RunSpend | null
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

function workSummary(items: readonly Evidence[]): string {
  const { skills, read: count, searches, changed, commands, retried } = workCount(items)
  const read = readPhrase(count)
  // A command the agent fixed and ran again is not a failure line, but it is not hidden either.
  const retries = retried ? ` (${retried} needed another try)` : ''
  const parts = [
    skills && `used ${plural(skills, 'skill')}`,
    read && `read ${read}`,
    searches && `ran ${plural(searches, 'search', 'searches')}`,
    changed && `changed ${plural(changed, 'file')}`,
    commands && `ran ${plural(commands, 'command')}${retries}`,
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

/** Whether the operator answered this request in the agent's place, rather than declining it. */
function answeredInstead(item: Evidence): boolean {
  const outcome = item.rawOutput as { optionId?: unknown } | null
  return item.kind === 'permission' && outcome?.optionId === 'answer'
}

/**
 * Refused requests as the agent's lines: one per switch, so ten refused searches read as one. A
 * request you answered in the agent's place is said as that, not as something it wasn't allowed.
 */
function refusalLines(agent: ReceiptAgent, items: readonly Evidence[], carriedOn: boolean): ReceiptLine[] {
  const refused = items.filter((item) => item.kind === 'permission' && item.status === 'rejected' && !answeredInstead(item))
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
  const answered = items.filter(answeredInstead)
  if (answered.length > 0) {
    const times = answered.length > 1 ? ` (${answered.length} times)` : ''
    lines.push({ tone: 'ok', text: `You answered in ${agent.name}’s place instead of letting it act${times}`, agentId: agent.id, evidenceId: answered[0].id })
  }
  return lines
}

/** Why a turn happened, as the receipt says it. */
const PURPOSE_WORDS: Record<TurnPurpose, string> = {
  work: 'The work',
  handover: 'Handovers',
  checkpoint: 'Checkpoints',
  ask: 'Answering teammates',
  note: 'Your notes and answers',
}

function tokenRow(label: string, group: { total: number; estimated: boolean }): ReceiptTokenRow {
  return { label, value: `${group.estimated ? '~' : ''}${formatTokens(group.total)}`, exact: `${group.total.toLocaleString('en-US')} tokens` }
}

/**
 * The run's tokens as the receipt prints them: one figure with its cache share and its cost, then
 * who spent them and on what. Nothing is printed for a run that reported none — a zero there would
 * claim the run cost nothing, when it only means nobody said.
 */
export function receiptTokens(summary: TokenSummary | null | undefined, names: ReadonlyMap<string, string>): ReceiptTokens | null {
  if (!summary || summary.total <= 0) return null
  const why: string[] = []
  if (summary.stoppedTurns > 0) why.push(`${summary.stoppedTurns === 1 ? 'A turn' : `${summary.stoppedTurns} turns`} stopped before ${summary.stoppedTurns === 1 ? 'it' : 'they'} ended, so ${summary.stoppedTurns === 1 ? 'it counts' : 'they count'} what was seen until then.`)
  return {
    ...tokenRow('Tokens', summary),
    cached: summary.cacheShare === null ? null : `${Math.round(summary.cacheShare * 100)}% cached`,
    // Beside each agent's tokens, what its calls cost, when every one of them said.
    agents: summary.agents.filter((agent) => agent.total > 0).map((agent) => {
      const row = tokenRow(names.get(agent.agentId) ?? agent.agentId, agent)
      const cost = costWords({ ...agent, costComplete: true })
      return cost === null ? row : { ...row, value: `${row.value} · ${cost}` }
    }),
    purposes: summary.purposes.filter((purpose) => purpose.total > 0).map((purpose) => tokenRow(PURPOSE_WORDS[purpose.purpose], purpose)),
    estimate: why.length > 0 ? `~ ${why.join(' ')}` : null,
    cost: costWords(summary),
  }
}

/** The stamp's word for each way a run ends: the words Details led with, now said on the slip. */
const PHASE_OUTCOME: Partial<Record<RunPhase, ReceiptOutcome>> = {
  succeeded: { word: 'Finished', tone: 'ok' },
  partial: { word: 'Finished with gaps', tone: 'warn' },
  failed: { word: 'Failed', tone: 'bad' },
  cancelled: { word: 'Stopped by you', tone: 'wait' },
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
      // A turn its app reported as failed still ends `end_turn`, so the stop reason says nothing:
      // name who reported it here, and what it said is under "Worth a look".
      const why = run.error ? ` (${input.harnessLabels.get(agent.id) || 'its model'} reported an error)`
        : run.stopReason ? ` (${run.stopReason.replace(/_/g, ' ')})` : run.exitCode !== null ? ` (exit code ${run.exitCode})` : ''
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
    anyRefused ||= refusals.some((line) => line.tone === 'bad')
    // Its app ended the turn at a decline, so the reply was finished on LoomWatch's request to
    // carry on (ADR 0046). That explains the turn; it is not a finding of its own.
    if (run.resumedTurns) {
      const app = input.harnessLabels.get(agent.id) ?? 'Its app'
      const times = run.resumedTurns > 1 ? ` (${run.resumedTurns} times)` : ''
      checks.push({ tone: 'warn', text: `${app} ends ${agent.name}’s turn when a request is declined, so LoomWatch asked ${agent.name} to carry on without it${times}`, agentId: agent.id, aside: true })
    }

    // Auto mode (ADR 0061): what ran without your answer, because it only read or downloaded.
    const autoRan = (input.projection.autoRan ?? []).filter((ran) => ran.agentId === agent.id)
    if (autoRan.length > 0) {
      const shown = autoRan.slice(0, 3).map((ran) => ran.detail ?? ran.title).join(', ')
      const more = autoRan.length > 3 ? ` and ${autoRan.length - 3} more` : ''
      const text = autoRan.length === 1
        ? `Auto mode let ${agent.name} run ${shown} without asking you: it only reads or downloads`
        : `Auto mode let ${agent.name} run ${autoRan.length} commands without asking you, each one only reading or downloading: ${shown}${more}`
      checks.push({ tone: 'ok', text, agentId: agent.id, aside: true })
    }

    for (const skill of run.requiredSkills ?? []) {
      if (skill.state !== 'opened') checks.push({ tone: 'warn', text: `${agent.name} was given the skill “${skill.name}” but the record never shows it opened`, agentId: agent.id })
    }
    if (run.openCalls > 0) checks.push({ tone: 'warn', text: `${plural(run.openCalls, 'call')} from ${agent.name} never reported back`, agentId: agent.id })
    // A tool that reaches past the run and ran without asking (ADR 0044), or an MCP server an AI
    // app brought that LoomWatch did not connect (ADR 0047): the call shows what it sent.
    for (const [tool, use] of outwardCalls(items, run.connectedServers)) {
      const what = use.does === null ? 'which LoomWatch didn’t connect' : `which ${use.does}`
      const times = use.calls.length > 1 ? ` (${use.calls.length} times)` : ''
      checks.push({ tone: 'bad', text: `${agent.name} ${use.completed ? 'used' : 'tried'} ${tool}, ${what}, without asking you${times}`, agentId: agent.id, evidenceId: use.calls[0].id })
    }
  }
  for (const alert of input.projection.attention) {
    checks.push({ tone: 'warn', text: alert.message, agentId: alert.agentId, evidenceId: alert.evidenceId })
  }
  if (anyRefused) checks.push({ tone: 'warn', text: 'What an agent isn’t allowed to do waits for your answer during a run. Requests you denied, or that nobody answered in time, were declined. Change what each agent may do on its workbench, in Agents.', aside: true })
  if (terminal && !input.answered) checks.push({ tone: 'bad', text: 'The run ended without an answer' })
  const money = spendNote({ spend: input.spend }, (id) => input.agents.find((agent) => agent.id === id)?.name ?? id)
  if (money) checks.push({ tone: input.spend?.stopped ? 'warn' : 'ok', text: money, aside: true })
  const gaps = Object.entries(input.projection.coverage).filter(([, value]) => value.level !== 'complete' && value.reason !== 'none_recorded')
  if (gaps.length) checks.push({ tone: 'warn', text: `Not everything was recorded: ${gaps.map(([key]) => key).join(', ')}` })

  const apps = [...new Set(input.agents.filter((agent) => !agent.operator).map((agent) => input.harnessLabels.get(agent.id)).filter(Boolean))]
  const helpers = input.agents.filter((agent) => !agent.operator)
  const operator = input.agents.some((agent) => agent.operator)
  return {
    run: `Run ${input.attempt}`,
    outcome: PHASE_OUTCOME[input.phase] ?? { word: 'In progress', tone: 'wait' },
    endedAt: input.projection.updatedAt ?? input.projection.startedAt,
    asked: input.prompt.trim() || 'No request was recorded',
    took: input.elapsed,
    team: `${plural(helpers.length, 'helper')}${operator ? ' + your review' : ''}`,
    ranOn: apps.length ? apps.join(', ') : 'Not recorded',
    tokens: receiptTokens(input.projection.tokens, new Map(input.agents.map((agent) => [agent.id, agent.name]))),
    lines,
    checks,
  }
}

const MARK: Record<ReceiptTone, string> = { ok: '✓', bad: '✗', warn: '!', wait: '…' }

/** The receipt as Markdown, for a pull request, a ticket or a chat. */
export function receiptMarkdown(receipt: Receipt): string {
  const out = [
    `### ${receipt.run} · ${receipt.outcome.word}`,
    '',
    `- **Asked:** ${receipt.asked.split('\n')[0]}`,
    `- **Team:** ${receipt.team}`,
    `- **Took:** ${receipt.took}`,
    `- **Ran on:** ${receipt.ranOn}`,
    ...(receipt.tokens ? [`- **Tokens:** ${[receipt.tokens.value, receipt.tokens.cached].filter(Boolean).join(' · ')}`] : []),
    ...(receipt.tokens?.cost ? [`- **Cost:** ${receipt.tokens.cost}`] : []),
    '',
    ...receipt.lines.map((line) => `- ${MARK[line.tone]} ${line.text}`),
  ]
  if (receipt.checks.length) out.push('', '**Worth a look**', ...receipt.checks.map((line) => `- ${line.text}`))
  return out.join('\n')
}

export { MARK as RECEIPT_MARK }
