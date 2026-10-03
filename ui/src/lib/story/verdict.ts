import type { RunPhase } from '../watch/events'
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
  /** Sources the team read, across every agent. */
  sources: number
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/** The receipt's failures, then its "worth a look" checks, without the notes that only explain them. */
export function findingsOf(receipt: Receipt | null): ReceiptLine[] {
  if (!receipt) return []
  const seen = new Set<string>()
  return [...receipt.lines.filter((line) => line.tone === 'bad'), ...receipt.checks.filter((line) => !line.aside)]
    .filter((line) => !seen.has(line.text) && Boolean(seen.add(line.text)))
}

export function answerVerdict(input: VerdictInput): AnswerVerdict {
  const findings = findingsOf(input.receipt)
  const first = findings[0] ? `${findings[0].text}.` : ''
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
  if (findings.length) return { tone: 'look', label: `${plural(findings.length, 'thing')} to check`, detail: first, findings, reviewable: true }
  return {
    tone: 'ok',
    label: 'Nothing flagged',
    detail: input.sources
      ? `Every step finished, reading ${plural(input.sources, 'source')}, and nothing in the record was flagged.`
      : 'Every step finished and nothing in the record was flagged.',
    findings,
    reviewable: true,
  }
}
