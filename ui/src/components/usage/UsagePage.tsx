import { ExternalLink } from '../ui/icon'
import { useEffect, useId, useMemo, useState } from 'react'

import { sourceMaker } from '../../lib/ai/makers'
import type { ModelSource } from '../../lib/ai/modelIds'
import { CHATGPT_USAGE_PAGE, CLAUDE_BILLING_PAGE, SOURCE_INFO } from '../../lib/ai/sources'
import { nameWithHelpers } from '../../lib/chat/helpers'
import { useAiStatus } from '../../lib/ai/useKeyStatus'
import { type AgentUsage, type ClaudePlan, type Feature, type FeatureUsage, type NextSteps, type SourceUsage, type UsageReport, cycleStart, fetchNextSteps, fetchUsage, keepClaudePlan, readClaudePlan, saveNextSteps, spentSince, tokensOf } from '../../lib/usage/client'
import { announceReadingStatus, fetchReadingStatus, saveReadingEnabled, type ReadingStatus } from '../../lib/ai/reading'
import { isMac } from '../../lib/platform'
import { formatCost, formatTokens } from '../../lib/watch/usage'
import { MakerMark } from '../models/MakerMark'
import { SourceChip } from '../models/ModelPicker'
import { DailyBars, type DayValue } from './DailyBars'
import { YouTabs } from '../you/YouTabs'
import { LoomFace } from '../ui/glyphs'
import { SectionHead } from '../ui/SectionHead'

/** "Oct 1", from a UTC date (`2026-10-01`). */
function shortDate(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

const DAYS = 30
const OPENROUTER_CREDITS = 'https://openrouter.ai/settings/credits'
const CLAUDE_WORKSPACES = 'https://platform.claude.com/settings/workspaces'

/** "Oct 18, 14:02". */
function when(at: string): string {
  return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function money(dollars: number, estimated = false): string {
  return `${estimated ? '≈ ' : ''}${formatCost(dollars)}`
}

/** The last `DAYS` UTC dates, oldest first, ending today. */
function lastDays(now: Date): string[] {
  return Array.from({ length: DAYS }, (_, back) => new Date(now.getTime() - (DAYS - 1 - back) * 86_400_000).toISOString().slice(0, 10))
}

function requests(calls: number): string {
  return `${calls.toLocaleString()} ${calls === 1 ? 'request' : 'requests'}`
}

/** "12%", or "under 1%" for a share too small to round up to one. */
function share(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return '0%'
  const percent = Math.round((part / whole) * 100)
  return percent === 0 ? 'under 1%' : `${percent}%`
}

/**
 * What LoomWatch's agents and Ask used in the last 30 days, by how it was paid (ADR 0073). Each
 * source tells an app something different, so each card says what LoomWatch knows, says plainly what
 * it can't, and links to the source for the exact figure. Dollars for OpenRouter and the Claude
 * credit, requests and tokens for the ChatGPT plan: units never mix.
 */
export function UsagePage() {
  const ai = useAiStatus()
  const [report, setReport] = useState<UsageReport | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    fetchUsage(DAYS)
      .then((value) => { if (current) setReport(value) })
      .catch((caught: unknown) => { if (current) setError(caught instanceof Error ? caught.message : 'Usage isn’t available right now.') })
    return () => { current = false }
  }, [])

  const [now] = useState(() => new Date())
  const shownSources = useMemo(() => {
    const used = new Set((report?.sources ?? []).map((entry) => entry.source))
    const connected = new Set<ModelSource>()
    if (ai?.chatgpt.available && ai.chatgpt.connected) connected.add('chatgpt')
    if (ai?.anthropic.connected) connected.add('anthropic')
    if (ai?.openrouter.connected) connected.add('openrouter')
    return (['chatgpt', 'anthropic', 'openrouter'] as const).filter((source) => used.has(source) || connected.has(source))
  }, [ai, report])

  return (
    <main className="lw-settings">
      <div className="lw-settings-column usage-column">
        <YouTabs />
        <div className="lw-settings-head">
          <SectionHead page as="h1" className="t-display" title="Usage" explain={`What your agents and LoomWatch’s help used in the last ${DAYS} days, by how it was paid. Each card links to where you see the exact figure.`} />
        </div>
        {error && <p role="alert" className="inline-error t-body">{error}</p>}
        {!report && !error && <p role="status" className="t-meta lw-settings-quiet">Loading usage…</p>}
        {report && shownSources.length === 0 && (
          <p className="t-body lw-settings-quiet">Nothing is connected or used yet. <a className="link" href="/connections">Choose how your agents’ models are paid</a>.</p>
        )}
        {report && shownSources.length > 0 && <>
          <TwoTracks report={report} />
          <div className="lw-sources-grid usage-grid">
            {shownSources.map((source) => {
              const entry = report.sources.find((each) => each.source === source)
              const days = lastDays(now).map((day): DayValue => {
                const found = report.days.find((each) => each.day === day && each.source === source)
                const tokens = found ? tokensOf(found) : 0
                const help = found?.loomwatch
                return source === 'chatgpt'
                  ? { day, value: tokens, part: help ? tokensOf(help) : 0, said: found ? `${requests(found.calls)}, ${formatTokens(tokens)} tokens${help?.calls ? `, LoomWatch’s help ${formatTokens(tokensOf(help))} tokens` : ''}` : 'nothing' }
                  : { day, value: found?.costUsd ?? 0, part: help?.costUsd ?? 0, said: found ? `${money(found.costUsd, found.costEstimated)}, ${requests(found.calls)}${help?.calls ? `, LoomWatch’s help ${money(help.costUsd, help.costEstimated)}` : ''}` : 'nothing' }
              })
              return (
                <section key={source} className="e1 lw-settings-section lw-source-card usage-card" aria-labelledby={`usage-${source}`}>
                  <h2 id={`usage-${source}`} className="t-title lw-source-title"><MakerMark maker={sourceMaker(source)} />{SOURCE_INFO[source].heading}</h2>
                  {source === 'chatgpt' && <PlanCard entry={entry} days={days} />}
                  {source === 'anthropic' && <CreditCard entry={entry} days={days} report={report} now={now} />}
                  {source === 'openrouter' && <OpenRouterCard entry={entry} days={days} spentThisMonth={ai?.openrouter.spentThisMonth} limitRemaining={ai?.openrouter.limitRemaining} freeTier={ai?.openrouter.freeTier === true} />}
                </section>
              )
            })}
          </div>
          <WhereItWent report={report} openrouter={ai?.openrouter.connected === true} />
        </>}
      </div>
    </main>
  )
}

function PlanCard({ entry, days }: { entry?: SourceUsage; days: DayValue[] }) {
  const total = entry?.total
  const limit = entry?.lastProblem?.kind === 'plan_limit' ? entry.lastProblem : undefined
  return <>
    <p className="t-meta lw-source-cost">Plus plans have a 5-hour limit shared with every app that uses your plan; Pro plans don’t. You can also cap LoomWatch’s weekly share, from 10% to 100%, in ChatGPT’s settings.</p>
    <dl className="usage-figures">
      <div><dt className="t-meta">Last 5 hours</dt><dd className="t-body-m">{requests(entry?.lastFiveHours.calls ?? 0)}</dd><dd className="t-meta">{formatTokens(entry ? tokensOf(entry.lastFiveHours) : 0)} tokens</dd></div>
      <div><dt className="t-meta">Last 7 days</dt><dd className="t-body-m">{requests(entry?.lastSevenDays.calls ?? 0)}</dd><dd className="t-meta">{formatTokens(entry ? tokensOf(entry.lastSevenDays) : 0)} tokens</dd></div>
      <div><dt className="t-meta">Last 30 days</dt><dd className="t-body-m">{formatTokens(total ? tokensOf(total) : 0)} tokens</dd><dd className="t-meta">busiest day {formatTokens(entry?.peakDayTokens ?? 0)} · {entry?.activeDays ?? 0} active days</dd></div>
    </dl>
    <p className={`t-meta ${limit ? 'inline-error' : ''}`}>{limit ? `LoomWatch hit a limit on ${when(limit.at)}. ChatGPT doesn’t say when it resets.` : 'No limit hit in the last 30 days.'} ChatGPT doesn’t tell apps how much is left: see it in ChatGPT.</p>
    <TrackLine entry={entry} plan />
    <DailyBars days={days} title="Tokens a day" summary={`${formatTokens(total ? tokensOf(total) : 0)} tokens in 30 days`} />
    <div className="lw-settings-actions"><a className="btn btn-primary" href={CHATGPT_USAGE_PAGE} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden="true" />Manage usage</a></div>
  </>
}

const PLANS: { label: string; monthly: number | null }[] = [
  { label: 'Max 5x: $100 a month', monthly: 100 },
  { label: 'Max 20x: $200 a month', monthly: 200 },
  { label: 'Team: I’ll enter the amount', monthly: -1 },
  { label: 'I bought my own credits', monthly: null },
]

function CreditCard({ entry, days, report, now }: { entry?: SourceUsage; days: DayValue[]; report: UsageReport; now: Date }) {
  const [plan, setPlan] = useState<ClaudePlan | null>(() => readClaudePlan())
  const set = (next: ClaudePlan | null) => { setPlan(next); keepClaudePlan(next) }
  const since = cycleStart(now, plan?.renewsOn)
  const spent = spentSince(report.days, 'anthropic', since)
  const monthly = plan?.monthly ?? null
  const share = monthly && monthly > 0 ? Math.min(1, spent / monthly) : null
  const usedUp = entry?.lastProblem?.kind === 'out_of_credits' ? entry.lastProblem : undefined
  const choice = plan === null ? '' : plan.monthly === null ? 'own' : PLANS.some((each) => each.monthly === plan.monthly) ? String(plan.monthly) : 'team'
  return <>
    <p className="t-meta lw-source-cost">Anthropic doesn’t tell apps how much credit is left, so this counts what LoomWatch spent, at Claude’s list prices.</p>
    <div className="usage-plan">
      <label className="field">
        <span className="t-meta">Your plan</span>
        <select className="input" value={choice} onChange={(event) => {
          const value = event.target.value
          if (value === '') set(null)
          else if (value === 'own') set({ monthly: null, renewsOn: plan?.renewsOn })
          else if (value === 'team') set({ monthly: plan?.monthly && plan.monthly > 0 ? plan.monthly : 100, renewsOn: plan?.renewsOn })
          else set({ monthly: Number(value), renewsOn: plan?.renewsOn })
        }}>
          <option value="">Choose…</option>
          {PLANS.map((each) => <option key={each.label} value={each.monthly === null ? 'own' : each.monthly === -1 ? 'team' : String(each.monthly)}>{each.label}</option>)}
        </select>
      </label>
      {choice === 'team' && <label className="field"><span className="t-meta">Credit a month ($)</span><input className="input" type="number" min={1} max={500} value={plan?.monthly ?? ''} onChange={(event) => set({ monthly: Number(event.target.value) || null, renewsOn: plan?.renewsOn })} /></label>}
      {plan && <label className="field"><span className="t-meta">Renews on day</span><input className="input" type="number" min={1} max={28} value={plan.renewsOn ?? 1} onChange={(event) => set({ ...plan, renewsOn: Number(event.target.value) || 1 })} /></label>}
    </div>
    {share !== null && monthly
      ? <div className="usage-meter" role="meter" aria-valuemin={0} aria-valuemax={monthly} aria-valuenow={Number(spent.toFixed(2))} aria-label="Claude API credit used in LoomWatch this month">
          <span className="t-body-m">≈ {formatCost(spent)} of your ${monthly} used in LoomWatch since {shortDate(since)}</span>
          <span className="usage-meter-track"><span className={`usage-meter-fill${share >= 0.8 ? ' high' : ''}`} style={{ width: `${Math.round(share * 100)}%` }} /></span>
        </div>
      : <p className="t-body-m">≈ {formatCost(spent)} spent in LoomWatch since {shortDate(since)}</p>}
    <p className="t-meta lw-settings-quiet">Other apps using keys in the same Console organization spend this credit too, so your real balance can be lower.</p>
    {usedUp && <p className="t-meta inline-error">Used up on {when(usedUp.at)}. It comes back with your next bill, or add credits in the Claude Console.</p>}
    <TrackLine entry={entry} />
    <DailyBars days={days} title="Dollars a day" summary={`${money(entry?.total.costUsd ?? 0, true)} in 30 days`} />
    <div className="lw-settings-actions">
      <a className="btn" href={CLAUDE_BILLING_PAGE} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden="true" />See exact balance</a>
      <a className="link" href={CLAUDE_WORKSPACES} target="_blank" rel="noreferrer">Set a spend limit</a>
    </div>
  </>
}

function OpenRouterCard({ entry, days, spentThisMonth, limitRemaining, freeTier }: { entry?: SourceUsage; days: DayValue[]; spentThisMonth?: number; limitRemaining?: number | null; freeTier: boolean }) {
  return <>
    <p className="t-meta lw-source-cost">What OpenRouter says about your key, beside what LoomWatch spent through it.</p>
    <dl className="usage-figures">
      <div><dt className="t-meta">This key this month</dt><dd className="t-body-m">{spentThisMonth === undefined ? '–' : formatCost(spentThisMonth)}</dd></div>
      <div><dt className="t-meta">In LoomWatch, 30 days</dt><dd className="t-body-m">{formatCost(entry?.total.costUsd ?? 0)}</dd><dd className="t-meta">{requests(entry?.total.calls ?? 0)}</dd></div>
      <div><dt className="t-meta">Left under the key’s limit</dt><dd className="t-body-m">{limitRemaining === undefined || limitRemaining === null ? 'No limit set' : formatCost(limitRemaining)}</dd></div>
    </dl>
    {freeTier && <p className="t-meta">This account has no credits yet, so only free models work.</p>}
    {entry?.lastProblem?.kind === 'out_of_credits' && <p className="t-meta inline-error">Out of credits on {when(entry.lastProblem.at)}.</p>}
    <TrackLine entry={entry} />
    <DailyBars days={days} title="Dollars a day" summary={`${formatCost(entry?.total.costUsd ?? 0)} in 30 days`} />
    <div className="lw-settings-actions"><a className="btn" href={OPENROUTER_CREDITS} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden="true" />Balance and top-up</a></div>
  </>
}

/** What LoomWatch's own help did, in the words a person would use (the daemon's `FEATURE`). */
const FEATURES: Readonly<Record<Feature, string>> = {
  ask: 'Ask LoomWatch',
  reading: 'Working out what a message needs',
  checking: 'Checking answers against what you asked',
  learning: 'Learning from your feedback',
  next_steps: 'Next-step suggestions at the notch',
  choosing_models: 'Choosing agents’ models',
}

/**
 * The help a person can turn off here, listed with its switch even before it is used, where it can
 * do something: the notch is the Mac's, and choosing models reads through OpenRouter.
 */
function offered(feature: Feature, openrouter: boolean): boolean {
  if (feature === 'next_steps') return isMac()
  return feature === 'choosing_models' && openrouter
}

/**
 * A row's team and agent in plain words: an agent's helper after its agent, and an agent's own chat
 * (its team file is named "Cole · chat") as its own chat.
 */
function rowNames(agent: AgentUsage, names: ReadonlyMap<string, ReadonlyMap<string, string>>): { team: string; agent: string } {
  const team = agent.team && !agent.team.endsWith(' · chat') ? agent.team : 'Own chat'
  return { team, agent: agent.agentName ?? nameWithHelpers(names.get(agent.team ?? '') ?? new Map(), agent.agentId) ?? agent.agentId }
}

/**
 * Each kind of use at a glance, before the ways of paying: what the agents' work used, and what
 * LoomWatch's own help did, each as a share of the whole. Dollars and a plan's tokens are said
 * apart, since a plan's are no dollars; tokens, as its chart counts them.
 */
function TwoTracks({ report }: { report: UsageReport }) {
  const paid = report.sources.filter((source) => source.source !== 'chatgpt')
  const dollars = paid.reduce((sum, source) => sum + source.total.costUsd, 0)
  const helpDollars = paid.reduce((sum, source) => sum + source.loomwatch.costUsd, 0)
  const estimated = paid.some((source) => source.total.costEstimated)
  const plan = report.sources.find((source) => source.source === 'chatgpt')
  const planTokens = plan ? tokensOf(plan.total) : 0
  const helpPlan = plan ? tokensOf(plan.loomwatch) : 0
  const tracks = [
    { key: 'whole', title: 'Your agents', mark: null, dollars: dollars - helpDollars, plan: planTokens - helpPlan, about: 'Work for your teams, and answers in your agents’ chats' },
    { key: 'part', title: 'LoomWatch’s help', mark: <LoomFace size={16} />, dollars: helpDollars, plan: helpPlan, about: isMac() ? 'Ask, checking answers, suggestions at the notch, and more' : 'Ask, checking answers, and more' },
  ]
  return (
    <section className="usage-tracks" aria-label="What models were used for">
      <p className="t-meta usage-tracks-when">Last {DAYS} days</p>
      {tracks.map((track) => (
        <div key={track.key} className="e1 lw-settings-section usage-track">
          <h2 className="t-meta usage-track-title">{track.mark}{track.title}</h2>
          {(paid.length > 0 || !plan) && <p className="usage-track-figure"><span className="t-title">{money(Math.max(0, track.dollars), estimated)}</span> <span className="t-meta">{share(track.dollars, dollars)} of the cost</span></p>}
          {plan && <p className="usage-track-figure"><span className="t-body-m">{formatTokens(Math.max(0, track.plan))} tokens</span> <span className="t-meta">{share(track.plan, planTokens)} of the tokens</span></p>}
          <p className="t-meta usage-track-about">{track.about}</p>
        </div>
      ))}
    </section>
  )
}

/**
 * How a source's 30 days split between the agents' work and LoomWatch's own help, right over its
 * chart, whose key it is: solid for the agents, striped for the help, as the bars draw them.
 */
function TrackLine({ entry, plan = false }: { entry?: SourceUsage; plan?: boolean }) {
  if (!entry) return null
  const help = entry.loomwatch
  const said = plan
    ? [`${formatTokens(tokensOf(entry.total) - tokensOf(help))} tokens`, `${formatTokens(tokensOf(help))} tokens`]
    : [money(entry.total.costUsd - help.costUsd, entry.total.costEstimated), money(help.costUsd, help.costEstimated)]
  return (
    <p className="t-meta usage-split">
      <span>{DAYS} days:</span>
      <span><i className="usage-key-whole" aria-hidden="true" />Your agents {said[0]}</span>
      <span><i className="usage-key-part" aria-hidden="true" />LoomWatch’s help {said[1]}</span>
    </p>
  )
}

function WhereItWent({ report, openrouter }: { report: UsageReport; openrouter: boolean }) {
  // Each team's agents by name, so a helper, which the run names by its agent's id, reads after it.
  const names = useMemo(() => {
    const byTeam = new Map<string, Map<string, string>>()
    for (const agent of report.agents) {
      if (!agent.agentName) continue
      const team = byTeam.get(agent.team ?? '') ?? new Map<string, string>()
      team.set(agent.agentId, agent.agentName)
      byTeam.set(agent.team ?? '', team)
    }
    return byTeam
  }, [report.agents])
  return (
    <section className="e1 lw-settings-section" aria-labelledby="usage-where">
      <h2 id="usage-where" className="t-title">Where it went</h2>
      {report.agents.length > 0 && <>
      <h3 className="t-body-m usage-where-title">Your agents</h3>
      <div className="usage-table-wrap">
        <table className="usage-table t-meta">
          <thead><tr><th scope="col">Team</th><th scope="col">Agent</th><th scope="col">Paid by</th><th scope="col">Runs</th><th scope="col" className="usage-col-tokens">Tokens</th><th scope="col">Cost</th></tr></thead>
          <tbody>
            {report.agents.map((agent) => {
              const named = rowNames(agent, names)
              return (
                <tr key={`${agent.team ?? ''}:${agent.agentId}:${agent.source}`}>
                  <td>{named.team}</td>
                  <td>{named.agent}</td>
                  <td><SourceChip source={agent.source} /></td>
                  <td>{agent.runs}</td>
                  <td className="usage-col-tokens">{formatTokens(tokensOf(agent))}</td>
                  <td>{agent.source === 'chatgpt' ? 'Plan' : money(agent.costUsd, agent.costEstimated)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      </>}
      <HelpTable features={report.features} openrouter={openrouter} />
    </section>
  )
}

/** Why most of LoomWatch's help has no switch, behind its heading's "?". */
const HELP_STAYS = 'Ask runs only when you use it, and learning only when you give feedback. Working out what a message needs stops a “hi” from starting the whole team, and checking holds answers to what you asked, so both stay on.'

/**
 * LoomWatch's own help, by what it did and how it was paid, with a switch where it can be done
 * without: the next-step suggestions at the notch, and choosing agents' models (Let AI choose). The
 * rest is how LoomWatch works, so it has none.
 */
function HelpTable({ features, openrouter }: { features: readonly FeatureUsage[]; openrouter: boolean }) {
  const rows: (FeatureUsage | { feature: Feature; source?: undefined })[] = [
    ...features,
    ...(['next_steps', 'choosing_models'] as const)
      .filter((feature) => offered(feature, openrouter) && !features.some((each) => each.feature === feature))
      .map((feature) => ({ feature })),
  ]
  if (rows.length === 0) return null
  return <>
    <SectionHead as="h3" className="t-body-m usage-where-title" lead={<LoomFace size={16} />} title="LoomWatch’s help" explain={HELP_STAYS} />
    <div className="usage-table-wrap">
      <table className="usage-table t-meta">
        <thead><tr><th scope="col">What it did</th><th scope="col">Paid by</th><th scope="col">Requests</th><th scope="col" className="usage-col-tokens">Tokens</th><th scope="col">Cost</th></tr></thead>
        <tbody>
          {rows.map((row) => {
            // A switch on the first of a feature's rows only: one control per thing. It sits beside
            // the feature's name, so a narrow screen shows it without scrolling the table sideways.
            const first = rows.find((each) => each.feature === row.feature) === row
            const control = first && row.feature === 'next_steps' ? <NextStepsSwitch /> : first && row.feature === 'choosing_models' ? <ChoosingSwitch /> : null
            return (
              <tr key={`${row.feature}:${row.source ?? ''}`}>
                <td><div className="usage-feature"><span className="usage-feature-name">{FEATURES[row.feature]}</span>{control && <span className="usage-feature-switch">{control}</span>}</div></td>
                <td>{row.source ? <SourceChip source={row.source} /> : '–'}</td>
                <td>{row.source ? row.calls : '–'}</td>
                <td className="usage-col-tokens">{row.source ? formatTokens(tokensOf(row)) : '–'}</td>
                <td>{!row.source ? '–' : row.source === 'chatgpt' ? 'Plan' : money(row.costUsd, row.costEstimated)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  </>
}

/**
 * One switch in a row, with what turning it on costs under it while it is off (`hint`), and what
 * went wrong if a change didn't go through.
 */
function RowSwitch({ on, label, hint, onChange }: { on: boolean; label: string; hint?: string; onChange: (next: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')
  const hintId = useId()
  const hinted = Boolean(hint) && !on
  return <>
    <label className="lw-settings-switch">
      <input type="checkbox" role="switch" checked={on} disabled={busy} aria-label={label} aria-describedby={hinted ? hintId : undefined} onChange={(event) => {
        const next = event.target.checked
        setBusy(true)
        setFailed('')
        onChange(next).catch((caught: unknown) => setFailed(caught instanceof Error ? caught.message : 'That didn’t change. Try again.')).finally(() => setBusy(false))
      }} />
      <span className="lw-settings-switch-track" aria-hidden="true"><i /></span>
    </label>
    {hinted && <span id={hintId} className="t-meta usage-switch-hint">{hint}</span>}
    {failed && <span className="inline-error usage-switch-failed" role="alert">{failed}</span>}
  </>
}

function NextStepsSwitch() {
  const [state, setState] = useState<NextSteps | null>(null)
  useEffect(() => { fetchNextSteps().then(setState, () => setState(null)) }, [])
  if (!state) return null
  return <RowSwitch on={state.on} label="Write next-step suggestions at the notch" onChange={async (on) => {
    const now = await saveNextSteps(on)
    if (now) setState(now)
  }} />
}

function ChoosingSwitch() {
  const [state, setState] = useState<ReadingStatus | null>(null)
  useEffect(() => { fetchReadingStatus().then(setState, () => setState(null)) }, [])
  if (!state) return null
  return <RowSwitch on={state.enabled} label="Let AI choose agents’ models" hint="Uses your OpenRouter credits." onChange={async (on) => {
    const now = await saveReadingEnabled(on)
    setState(now)
    announceReadingStatus(now)
  }} />
}
