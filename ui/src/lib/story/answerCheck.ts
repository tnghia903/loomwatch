import { capabilityEvidence } from '../runs/capabilityEvidence'
import { isTerminalRun, type RunRecord } from '../runs/client'
import { settleAfterRun } from '../runs/settle'
import type { AgentConfig } from '../team-file/types'
import type { RunProjection } from '../watch/events'
import { readCount } from './reads'
import { buildReceipt, type Receipt } from './receipt'
import { answerVerdict, type AnswerVerdict } from './verdict'

/** One member of the team, as the chat knows it, with its configuration when the team file has it. */
export interface CheckParty {
  id: string
  name: string
  operator: boolean
  config?: AgentConfig
}

export interface AnswerCheck {
  verdict: AnswerVerdict
  receipt: Receipt | null
  /** Skills the team requires, and how many have loading evidence: what a review rests on. */
  required: number
  opened: number
}

export interface CheckInput {
  record: RunRecord
  projection: RunProjection
  /** The team in its stage order. Helpers that ran without being on it are added from the record. */
  parties: readonly CheckParty[]
  answer: string
  streaming: boolean
  /** Every archived event has arrived; until then a finished run's receipt is incomplete. */
  settled: boolean
  reviewed: boolean
}

/**
 * Whether a piece of work's answer holds anything to check before it is used (ADR 0051): the run
 * receipt and the verdict Details printed beside its own copy of the answer, now worked out from
 * one run's record so the chat can say it on the answer itself. The rules are the receipt's and
 * the verdict's (lib/story/receipt.ts, verdict.ts); this only gathers what they read.
 *
 * Who did what is settled the way the stage cards settle it (`settleAfterRun`): a stage kept alive
 * after it handed over finished its part, and anyone still mid-task ended with the run.
 */
export function checkAnswer({ record, projection, parties, answer, streaming, settled, reviewed }: CheckInput): AnswerCheck {
  const phase = projection.phase
  // Over by its record, or by its events — a run whose stages did not all finish ends `partial`.
  const terminal = isTerminalRun(record.status) || ['succeeded', 'partial', 'failed', 'cancelled'].includes(phase)
  const projected = new Map(projection.agents.map((agent) => [agent.id, agent]))
  // A one-agent turn ran that agent alone: the others were never asked, so they are not "missing".
  const members = record.onlyAgent ? parties.filter((party) => party.id === record.onlyAgent) : [...parties]
  for (const agent of projection.agents) {
    if (!members.some((party) => party.id === agent.id) && !parties.some((party) => party.id === agent.id)) members.push({ id: agent.id, name: agent.id, operator: false })
  }
  const order = members.map((party) => party.id)
  const pipeline = record.mode === 'pipeline'
  const runtime = (party: CheckParty) => {
    const run = projected.get(party.id)
    if (!run) return null
    const index = order.indexOf(party.id)
    const laterStageStarted = pipeline && order.slice(index + 1).some((later) => projected.has(later))
    return { status: settleAfterRun(run.status, { phase, operator: party.operator, laterStageStarted })?.status ?? run.status }
  }
  const evidenceByAgent = new Map(members.map((party) => [party.id, projection.evidence.filter((item) => item.agentId === party.id)]))
  const receipt = terminal
    ? buildReceipt({
        attempt: 0,
        prompt: record.prompt,
        phase,
        elapsed: '',
        agents: members.map((party) => ({ id: party.id, name: party.name, operator: party.operator, runtime: runtime(party), allow: party.config?.allow })),
        projection,
        evidenceByAgent,
        harnessLabels: new Map(),
        answered: Boolean(answer),
      })
    : null
  const verdict = answerVerdict({ phase, text: answer, streaming, terminal, settled, reviewed, receipt, read: readCount(projection.evidence) })
  const required = members.flatMap((party) => (party.config
    ? capabilityEvidence(party.config, evidenceByAgent.get(party.id) ?? [], projected.get(party.id)?.requiredSkills).filter((item) => item.required)
    : []))
  return { verdict, receipt, required: required.length, opened: required.filter((item) => item.state === 'read' || item.state === 'loaded').length }
}
