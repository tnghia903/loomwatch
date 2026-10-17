import type { RunRecord, RunSpend, SpendStop } from './client'

/** What a new team, and every starter team, may spend on one run (ADR 0068). A file that says nothing has no limit. */
export const NEW_TEAM_PER_RUN_USD = 1

/**
 * What a run spent and may spend, as the operator reads it (ADR 0068). The figures are the
 * daemon's: the exact cost OpenRouter reported for every call of the run, added up. Nothing here
 * estimates.
 */

/**
 * Dollars as written: `$1.00`, `$0.12`, and under a dollar to three figures, so `$0.012` and
 * `$0.003` never read as `$0.01` or `$0.00`. The daemon writes its own sentences the same way
 * (`spend::usd`).
 */
export function dollars(amount: number): string {
  if (!(amount > 0)) return '$0.00'
  if (amount >= 1) return `$${amount.toFixed(2)}`
  const places = Math.min(6, Math.max(2, 2 - Math.floor(Math.log10(amount))))
  return `$${amount.toFixed(places).replace(/(\.\d\d\d*?)0+$/, '$1')}`
}

/**
 * A limit as a field shows it: whole cents as `0.30`, and anything finer as written (`0.003`,
 * `0.255`), so a limit that is set never reads as `0.00` or as a figure it is not.
 */
export function dollarField(amount: number): string {
  const cents = amount.toFixed(2)
  return Number(cents) === amount ? cents : String(amount)
}

/**
 * The limit a typed figure sets: whole cents, but never rounded down to nothing, so a figure under
 * half a cent stays as typed. `null` for an empty field or no positive figure.
 */
export function typedDollars(text: string): number | null {
  const amount = Number(text)
  if (text.trim() === '' || !Number.isFinite(amount) || amount <= 0) return null
  const cents = Math.round(amount * 100) / 100
  return cents > 0 ? cents : amount
}

/** "The team used its $1.00", "Researcher used its $0.30": what a stop is about. */
export function stopSentence(stop: SpendStop): string {
  return `${stop.agent ? stop.name || stop.agent : 'The team'} used its ${dollars(stop.limitUsd)} for this run.`
}

/** The two answers at a stop, worded for whose limit it is. */
export function stopActions(stop: SpendStop): { add: string; finish: string } {
  return {
    add: `Add ${dollars(stop.addUsd)} and carry on`,
    finish: stop.agent ? `Stop ${stop.name || stop.agent} here` : 'Finish with what it has',
  }
}

/** One agent's thread on the spool: its share of what the run spent. */
export interface Thread {
  agent: string
  usd: number
}

/** What the spool draws: the limit (if any), what was spent, and each agent's thread, biggest first. */
export interface SpoolView {
  limit: number | null
  spent: number
  /** Spent over limit, 0–1; `null` without a limit. Past 1 when a call went over. */
  used: number | null
  threads: Thread[]
}

/** The spool of a run, or `null` when it has nothing to show: no record of spend, or nothing spent and no limit. */
export function spoolOf(spend: RunSpend | null | undefined): SpoolView | null {
  if (!spend) return null
  const limit = spend.limitUsd != null && spend.limitUsd > 0 ? spend.limitUsd : null
  if (limit === null && spend.spentUsd <= 0) return null
  const threads = Object.entries(spend.agents ?? {})
    .map(([agent, share]) => ({ agent, usd: share.spentUsd }))
    .filter((thread) => thread.usd > 0)
    .sort((a, b) => b.usd - a.usd)
  return { limit, spent: spend.spentUsd, used: limit === null ? null : spend.spentUsd / limit, threads }
}

/** "$0.12 of $1.00", or "$0.12" for a run with no limit. */
export function spoolWords(view: SpoolView): string {
  return view.limit === null ? dollars(view.spent) : `${dollars(view.spent)} of ${dollars(view.limit)}`
}

/** Said aloud: the figure, then each agent's share by name. */
export function spoolLabel(view: SpoolView, name: (id: string) => string): string {
  const shares = view.threads.map((thread) => `${name(thread.agent)} ${dollars(thread.usd)}`).join(', ')
  const head = view.limit === null ? `Spent ${dollars(view.spent)}` : `Spent ${dollars(view.spent)} of ${dollars(view.limit)}`
  return shares ? `${head}: ${shares}` : head
}

/** The stops a live run waits at. */
export function openStops(run: Pick<RunRecord, 'spendStops' | 'status'>): SpendStop[] {
  return run.status === 'running' || run.status === 'starting' ? run.spendStops ?? [] : []
}

/**
 * The receipt's line about money: what was added at a stop, and why the run stopped there, when it
 * did. `null` when the run never met its limit.
 */
export function spendNote(run: Pick<RunRecord, 'spend'>, name: (id: string) => string): string | null {
  const spend = run.spend
  if (!spend) return null
  const parts: string[] = []
  for (const top of spend.added ?? []) {
    parts.push(top.agent
      ? `You added ${dollars(top.addUsd)} for ${name(top.agent)} at ${dollars(top.atUsd)}`
      : `You added ${dollars(top.addUsd)} at ${dollars(top.atUsd)}`)
  }
  const limit = spend.limitUsd != null ? dollars(spend.limitUsd) : null
  if (spend.stopped === 'finished' && limit) parts.push(`Stopped at its ${limit}: you finished with what it had`)
  if (spend.stopped === 'nobody_to_ask' && limit) parts.push(`Stopped at its ${limit}: nobody was there to add more`)
  for (const [agent, share] of Object.entries(spend.agents ?? {})) {
    if (share.stopped && share.limitUsd != null) parts.push(`You stopped ${name(agent)} at its ${dollars(share.limitUsd)}`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}
