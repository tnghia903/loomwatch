import type { RunPhase } from '../watch/events'
import { checkProgress, type AnswerNotes, type CheckRound } from './checks'
import { readPhrase, type ReadCount } from './reads'
import type { Receipt, ReceiptLine } from './receipt'

/**
 * The verdict on a team's answer: the one word that sits beside its title.
 *
 * "Response available" told the reader what the panel below already showed. What they cannot see
 * from the answer is whether its record holds anything to check before they use it, so the verdict
 * says that, from the run receipt (lib/story/receipt.ts) and nothing else: a failed or refused call
 * the agent carried on without, a skill it was given but never opened, a step that did not finish.
 * Nothing is inferred from the answer's own prose.
 */
export type VerdictTone = 'ok' | 'look' | 'bad' | 'live'

export interface AnswerVerdict {
  tone: VerdictTone
  /** The badge, a few words. */
  label: string
  /** One sentence above the answer: the finding most worth a look, or what the answer rests on.
      The rest of the findings are counted beside it, not written out. */
  detail: string
  /** What the reviewer should look at, worst first. */
  findings: ReceiptLine[]
  /** The badge opens the review, because there is a finished answer to review. */
  reviewable: boolean
}

export interface VerdictInput {
  phase: RunPhase
  text: string
  streaming: boolean
  terminal: boolean
  /** Every archived event has arrived; a replay's receipt is incomplete until then. */
  settled: boolean
  reviewed: boolean
  /** Only a finished run has one. */
  receipt: Receipt | null
  /** What the team read successfully, across every agent, each thing once (lib/story/reads.ts). */
  read: ReadCount
  /** What the team's check steps found (ADR 0062): a missed or unsure check is worth a look. */
  checks?: readonly CheckRound[]
  /** What the answer's author said it could not meet, or kept against a check (ADR 0062). */
  notes?: AnswerNotes | null
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/** The receipt's failures, then its "worth a look" checks, without the notes that only explain them. */
export function findingsOf(receipt: Receipt | null): ReceiptLine[] {
  if (!receipt) return []
  const seen = new Set<string>()
  return [...receipt.lines.filter((line) => line.tone === 'bad'), ...receipt.checks.filter((line) => !line.aside)]
    .filter((line) => !seen.has(line.text) && Boolean(seen.add(line.text)))
}

/**
 * A check step's missed and unsure items, as findings: a missed check first, then an unsure one. A
 * check whose reply could not be read is one finding: its items were never checked, and listing
 * each as "not sure" would say they were looked at.
 */
export function checkFindings(checks: readonly CheckRound[] = []): ReceiptLine[] {
  const read = checks.filter((round) => round.readable !== false)
  const items = read.flatMap((round) => round.items.map((item) => ({ ...item, checker: round.checker })))
  return [
    ...checks.filter((round) => round.readable === false).map((round) => ({ tone: 'warn' as const, text: 'The check could not be read, so nothing it checked is confirmed', agentId: round.checker })),
    ...items.filter((item) => item.verdict === 'not_met').map((item) => ({ tone: 'warn' as const, text: `Check not met: ${item.item}${item.evidence ? ` (${item.evidence})` : ''}`, agentId: item.checker })),
    ...items.filter((item) => item.verdict === 'not_sure').map((item) => ({ tone: 'warn' as const, text: `Check not sure: ${item.item}`, agentId: item.checker })),
  ]
}

/**
 * What the check fixed before the answer was shown, in one sentence; empty when nothing was sent
 * back. Only the last round decides the badge, so without this the problems a send-back fixed
 * would never be seen.
 */
export function checkProgressSentence(checks: readonly CheckRound[] = []): string {
  let found = 0
  let fixed = 0
  for (const round of checks) {
    const progress = checkProgress(round)
    if (!progress) continue
    found += progress.found
    fixed += progress.fixed
  }
  if (found === 0) return ''
  const problems = plural(found, 'problem')
  if (fixed === 0) return `The check found ${problems}, and none was fixed when the work was sent back.`
  const which = fixed < found ? `${fixed} of them ${fixed === 1 ? 'was' : 'were'}` : found === 1 ? 'it was' : found === 2 ? 'both were' : 'all were'
  return `The check found ${problems}, and ${which} fixed before you saw this answer.`
}

/** The notes the daemon took off the end of the answer, as findings: they are no longer in it. */
export function noteFindings(notes?: AnswerNotes | null): ReceiptLine[] {
  if (!notes) return []
  return [
    ...notes.notMet.map((text) => ({ tone: 'warn' as const, text: `Could not meet: ${text}`, agentId: notes.agentId })),
    ...notes.missing.map((text) => ({ tone: 'warn' as const, text: `Missing: ${text}`, agentId: notes.agentId })),
    ...notes.notChanged.map((text) => ({ tone: 'warn' as const, text: `Kept against the check: ${text}`, agentId: notes.agentId })),
  ]
}

export function answerVerdict(input: VerdictInput): AnswerVerdict {
  // Worst first: a failure leads, then what the author itself could not meet, then the checks.
  const findings = [...noteFindings(input.notes), ...checkFindings(input.checks), ...findingsOf(input.receipt)]
    .sort((a, b) => Number(b.tone === 'bad') - Number(a.tone === 'bad'))
  const allMet = Boolean(input.checks?.length) && input.checks!.every((round) => round.items.every((item) => item.verdict === 'met'))
  const first = findings[0] ? `${findings[0].text}.` : ''
  const fixed = checkProgressSentence(input.checks)
  const withFixed = (detail: string) => (fixed ? `${detail} ${fixed}` : detail)
  if (input.streaming) return { tone: 'live', label: 'Writing', detail: 'The team is still writing this answer.', findings, reviewable: false }
  if (!input.text) {
    return input.terminal
      ? { tone: 'bad', label: 'No answer', detail: 'The run ended without a captured response.', findings, reviewable: false }
      : { tone: 'live', label: 'In progress', detail: 'The team’s response will appear here.', findings, reviewable: false }
  }
  if (!input.terminal || !input.receipt) return { tone: 'live', label: 'In progress', detail: 'The run is still going, so this answer may change.', findings, reviewable: false }
  if (!input.settled) return { tone: 'live', label: 'Reading the record', detail: 'Checking this run’s record for anything worth a look.', findings: [], reviewable: false }
  if (input.reviewed) return { tone: 'ok', label: 'Reviewed by you', detail: 'You reviewed this answer and its evidence.', findings, reviewable: true }
  if (input.phase !== 'succeeded') {
    return {
      tone: 'bad',
      label: input.phase === 'cancelled' ? 'Stopped early' : 'Partial answer',
      detail: first || 'The team did not finish, so parts of this answer may be missing.',
      findings,
      reviewable: true,
    }
  }
  // Approved at a check step's stop: you saw what was not met and kept the work as it was.
  const approvedOpen = (input.checks ?? []).filter((round) => round.approved).reduce((count, round) => count + round.items.filter((item) => item.verdict !== 'met').length, 0)
  if (findings.length && approvedOpen > 0) return { tone: 'look', label: `Approved with ${plural(approvedOpen, 'check')} not met`, detail: withFixed(`You approved it as it was. ${first}`), findings, reviewable: true }
  if (findings.length) return { tone: 'look', label: `${plural(findings.length, 'thing')} to check`, detail: withFixed(first), findings, reviewable: true }
  const read = readPhrase(input.read)
  return {
    tone: 'ok',
    label: 'Nothing flagged',
    detail: withFixed((read
      ? `Every step finished, reading ${read}, and nothing in the record was flagged.`
      : 'Every step finished and nothing in the record was flagged.') + (allMet ? ' Every check was met.' : '')),
    findings,
    reviewable: true,
  }
}
