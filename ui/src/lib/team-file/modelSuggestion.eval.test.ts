// @vitest-environment node
//
// How often the model suggestion is right, with and without reading agents' whole setups, on the
// labelled agents of suggestionCases.ts.
//
// Offline (every test run): the suggestion from names and keywords alone, and what it would be if
// every reading were right. It checks that every agent the keywords misread is one `needsReading`
// sends to be read, so turning reading on can reach it.
//
// Live: point it at a LoomWatch with an OpenRouter key and reading turned on (Connections), and it
// reads each agent `needsReading` picks through that LoomWatch, the same way the picker does, and
// prints the table (Vitest hides a passing test's output, hence --silent=false). Each setup is read
// once; running it again is answered from what was kept.
//
//   LOOMWATCH_EVAL_URL=http://127.0.0.1:3000 pnpm vitest run --silent=false src/lib/team-file/modelSuggestion.eval.test.ts
//
// LOOMWATCH_EVAL_ALL=1 also reads the agents the gate skips, to measure the reading itself: the
// suggestion still uses only the readings the app would ask for. LOOMWATCH_EVAL_OUT=<file> keeps
// every row and reading as JSON, so thresholds can be tried again without reading again.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

import { type JobKind, type SetupReading, needsReading, setupOf } from './agentSetup'
import { suggestModel } from './modelSuggestion'
import { type SuggestionCase, type Tier, exampleCases, renamedCases, tierOf, writtenCases } from './suggestionCases'
import type { TeamDocument } from './types'

const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../examples')
const teams: Record<string, TeamDocument> = {}
for (const folder of [examples, path.join(examples, 'usecases')]) {
  for (const file of readdirSync(folder).filter((name) => name.endsWith('.yaml'))) {
    teams[file.replace(/\.yaml$/, '')] = parse(readFileSync(path.join(folder, file), 'utf8')) as TeamDocument
  }
}
const cases: SuggestionCase[] = [...exampleCases(teams), ...renamedCases, ...writtenCases]

/** Labels that are their author's cost choice, not a misreading: no reading can match them. */
const COST_CHOICES = new Set([
  // The team's answer, put on the faster model to keep a daily digest cheap.
  'daily-tech-digest: Writer',
  // A researcher left on the default model; its job says gatherer.
  'capability-delivery: Market Researcher',
])

const KIND_FOR: Record<Tier, JobKind> = { strong: 'produce', fast: 'gather', check: 'check' }
const sure = (tier: Tier): SetupReading => ({ kind: KIND_FOR[tier], probabilities: { [KIND_FOR[tier]]: 0.95 }, confidence: 0.95 })
const got = (one: SuggestionCase, reading?: SetupReading | null) => tierOf(suggestModel({ agent: one.agent, team: one.team, reading }).model)

describe('model suggestion, measured', () => {
  it('sends every agent the keywords misread to be read', () => {
    const misread = cases.filter((one) => got(one) !== one.want && !COST_CHOICES.has(one.label))
    expect(misread.length).toBeGreaterThan(0)
    for (const one of misread) expect(needsReading(one.agent), one.label).toBe(true)
  })

  it('is right on every agent it reads, when the reading is', () => {
    for (const one of cases.filter((each) => needsReading(each.agent))) {
      if (COST_CHOICES.has(one.label)) continue
      expect(got(one, sure(one.want)), one.label).toBe(one.want)
    }
  })

  const url = process.env.LOOMWATCH_EVAL_URL?.replace(/\/$/, '')
  const readAll = process.env.LOOMWATCH_EVAL_ALL === '1'
  const out = process.env.LOOMWATCH_EVAL_OUT
  it.runIf(Boolean(url))('compares the suggestion with and without reading, through a running LoomWatch', async () => {
    const rows: string[] = []
    const records: { source: string; label: string; want: Tier; keywords: Tier | null; read: Tier | null; gated: boolean; reading: SetupReading | null }[] = []
    const totals: Record<string, { n: number; keywords: number; read: number; readings: number; unsure: number }> = {}
    for (const one of cases) {
      const before = got(one)
      let reading: SetupReading | null = null
      let note = ''
      const gated = needsReading(one.agent)
      if (gated || readAll) {
        const response = await fetch(`${url}/api/models/reading`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-LoomWatch-Request': '1' },
          body: JSON.stringify({ setup: setupOf(one.agent) }),
        })
        const body = await response.json() as { reading?: SetupReading; code?: string; error?: string }
        if (!response.ok) throw new Error(`${one.label}: ${body.code} ${body.error}`)
        reading = body.reading ?? null
        note = reading ? `${reading.kind} ${(reading.probabilities[reading.kind] ?? 0).toFixed(2)}${reading.confidence === undefined ? '' : ` c${reading.confidence.toFixed(2)}`}${gated ? '' : ' (not gated)'}` : 'no answer'
      }
      const after = got(one, gated ? reading : null)
      records.push({ source: one.source, label: one.label, want: one.want, keywords: before, read: after, gated, reading })
      const total = (totals[one.source] ??= { n: 0, keywords: 0, read: 0, readings: 0, unsure: 0 })
      total.n += 1
      if (before === one.want) total.keywords += 1
      if (after === one.want) total.read += 1
      if (reading && gated) total.readings += 1
      if (reading && gated && after === before && reading.kind !== KIND_FOR[before ?? 'strong']) total.unsure += 1
      rows.push(`${one.source.padEnd(8)} ${one.label.padEnd(44)} want ${one.want.padEnd(6)} keywords ${String(before).padEnd(6)} read ${String(after).padEnd(6)} ${note}`)
    }
    const all = Object.values(totals).reduce((sum, each) => ({ n: sum.n + each.n, keywords: sum.keywords + each.keywords, read: sum.read + each.read, readings: sum.readings + each.readings, unsure: sum.unsure + each.unsure }), { n: 0, keywords: 0, read: 0, readings: 0, unsure: 0 })
    const line = (name: string, each: typeof all) => `${name.padEnd(8)} right with keywords ${each.keywords}/${each.n}, with reading ${each.read}/${each.n}, setups read ${each.readings}, readings not sure enough to act on ${each.unsure}`
    // The reading itself, gate aside: its kind against the label's, on every agent it read.
    const answered = records.filter((each) => each.reading)
    const agrees = answered.filter((each) => each.reading?.kind === KIND_FOR[each.want]).length
    const agreement = `reading's kind matches the label on ${agrees}/${answered.length} agents read`
    console.log(['', ...rows, '', ...Object.entries(totals).map(([name, each]) => line(name, each)), line('all', all), agreement].join('\n'))
    if (out) writeFileSync(out, JSON.stringify(records, null, 2))
    expect(all.n).toBe(cases.length)
  }, 120_000)
})
