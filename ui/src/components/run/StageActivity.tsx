import type { ReactNode } from 'react'
import { ArrowRight, Check, ExternalLink, FileSearch, Globe, ListChecks, MessagesSquare, PencilLine, Sparkles, SquareTerminal, Wrench, type IconComponent } from '../ui/icon'

import type { WorkPhase } from '../../lib/library/figure'
import { givenInFull, type RunCapability } from '../../lib/runs/capabilityEvidence'
import { USE_NAMES, WEB_KINDS, type CardActivity, type Use, type UseKind, type WebFinds } from '../../lib/watch/cardActivity'
import type { Evidence } from '../../lib/watch/events'
import { formatOffset } from '../../lib/watch/events'
import { SuppliedInstructions } from './SuppliedInstructions'

/**
 * A stage card's run, as option A of the trace sketches drew it (Team handoff): its figure acts out
 * what it is at while the run is watched live, the call it is on is named under it, and a tray
 * holds one mark per kind of thing it used. A mark opens what is behind it in the card: what it
 * found on the web, its skills and whether it opened each, or the calls of that kind, each a way to
 * its record. Searches, pages and the programs that ran them share one web mark: one list, one mark.
 */
const USE_ICONS: Readonly<Record<UseKind, IconComponent>> = {
  skill: Sparkles,
  web: Globe,
  page: Globe,
  code: Globe,
  file: FileSearch,
  write: PencilLine,
  command: SquareTerminal,
  plan: ListChecks,
  ask: MessagesSquare,
  tool: Wrench,
}

/** The glow a figure wears for its state: blue working, gold waiting for you, green done, red failed. */
export type FigureGlow = 'working' | 'waiting' | 'done' | 'failed' | null

/** The figure, acting out `phase` while it works. Reduced motion keeps it still (delivery.css). */
export function StageFigure({ phase, glow, children }: { phase: WorkPhase | null; glow: FigureGlow; children: ReactNode }) {
  return <span className="stage-figure" data-phase={phase ?? undefined} data-glow={glow ?? undefined}>{children}</span>
}

/** What it is at now, in a few words: the start of its reasoning, or the call it is on by name. */
export function StageNow({ activity }: { activity: CardActivity }) {
  if (activity.doing) {
    const Icon = USE_ICONS[activity.doing.kind]
    return <p className="stage-now doing" aria-live="polite"><Icon size={13} aria-hidden="true" /><span>{activity.doing.label}</span></p>
  }
  if (activity.phase === 'thinking' && activity.thought) return <p className="stage-now thought" aria-live="polite"><span>{activity.thought}</span></p>
  return null
}

export interface SkillSummary {
  /** Every skill it was required to use or opened, with what the run shows of it. */
  skills: RunCapability[]
  required: number
  /** Required skills it opened, or was given in full in what it was sent. */
  met: number
}

/** A skill's state in a newcomer's words, from what the run shows of it. */
function skillState(skill: RunCapability, planned: boolean): string {
  if (planned && skill.required) return 'Gets it when it starts'
  if (skill.receipt?.state === 'opened' || skill.state === 'read') return 'Opened'
  if (givenInFull(skill)) return 'Given in full'
  if (skill.state === 'failed') return 'Couldn’t open'
  return 'Not opened'
}

/** The sentence a stage's skills open with: how many of the ones it must use it had. */
function skillCount(skills: SkillSummary, planned: boolean): string {
  const many = (count: number) => (count === 1 ? 'skill' : 'skills')
  if (planned) return `${skills.required} ${many(skills.required)} it must use. It gets them when it starts.`
  return `Opened or was given ${skills.met} of the ${skills.required} ${many(skills.required)} it must use.`
}

const pageCount = (web: WebFinds) => web.sites.reduce((sum, site) => sum + site.pages.length, 0)

/** What the web mark says it holds: "On the web: 5 pages read, 4 searches". */
function webWords(web: WebFinds): string {
  const pages = pageCount(web)
  const parts = [
    `${pages} ${pages === 1 ? 'page' : 'pages'} read`,
    web.searches.length > 0 && `${web.searches.length} ${web.searches.length === 1 ? 'search' : 'searches'}`,
  ].filter(Boolean)
  return `On the web: ${parts.join(', ')}`
}

export interface TrayProps {
  activity: CardActivity
  skills: SkillSummary
  planned: boolean
  /** The run is over, so a required skill it never opened was missed, not still to come. */
  finished: boolean
  /** The mark whose list is open in this card. */
  open: UseKind | null
  onOpen: (kind: UseKind | null) => void
}

/** One mark per kind of thing it used, with how many; skills count the required ones it had. */
export function StageTray({ activity, skills, planned, finished, open, onOpen }: TrayProps) {
  const marks = activity.tray.filter((mark) => mark.kind !== 'skill' && !WEB_KINDS.has(mark.kind))
  const onWeb = activity.tray.some((mark) => WEB_KINDS.has(mark.kind))
  // Skills it opened, each once, whether or not it was required to.
  const opened = new Set(activity.tray.find((mark) => mark.kind === 'skill')?.labels ?? []).size
  const skillMark = skills.skills.length > 0 || opened > 0
  if (!skillMark && !onWeb && marks.length === 0) return null
  // A required skill it never had, once the run is over, leaves the mark dashed: a gap to look at.
  const short = finished && !planned && skills.required > 0 && skills.met < skills.required
  const skillWords = skills.required > 0 ? skillCount(skills, planned) : `Opened ${opened} ${opened === 1 ? 'skill' : 'skills'}`
  const mark = (kind: UseKind, count: string, words: string, extra = '', doing = activity.doing?.kind === kind) => {
    const Icon = USE_ICONS[kind]
    return (
      <button key={kind} type="button" data-kind={kind} className={`stage-mark${extra}${doing ? ' doing' : ''}`} aria-expanded={open === kind} aria-label={words} title={words} onClick={() => onOpen(open === kind ? null : kind)}>
        <Icon size={14} aria-hidden="true" />{count && <span>{count}</span>}
      </button>
    )
  }
  const pages = pageCount(activity.web)
  return (
    <div className="stage-tray" role="group" aria-label="What it used">
      {skillMark && mark('skill', skills.required > 0 ? (planned ? String(skills.required) : `${skills.met}/${skills.required}`) : String(opened), skillWords, short ? ' short' : '')}
      {/* Pages are counted as the receipt counts them: each page once, and only one it got. */}
      {onWeb && mark('web', String(pages), webWords(activity.web), '', activity.doing !== null && WEB_KINDS.has(activity.doing.kind))}
      {marks.map((item) => {
        // Files are counted as the receipt counts them, each once; commands and the rest, each run.
        const count = item.kind === 'file' || item.kind === 'write' ? new Set(item.labels).size : item.labels.length
        return mark(item.kind, count > 1 ? String(count) : '', `${USE_NAMES[item.kind]}: ${count}`)
      })}
    </div>
  )
}

/** The pages it read, by site, the ones the answer links marked; what it searched and found. */
export function WebList({ web }: { web: WebFinds }) {
  const pages = pageCount(web)
  // A page a search listed is named by the title the search gave it; else by its address.
  const titles = new Map(web.searches.flatMap((search) => search.found.map((hit): [string, string] => [hit.url, hit.title])))
  const kept = web.searches.some((search) => search.query)
  return (
    <>
      {pages > 0 && (
        <section>
          <h4>Web pages read <span>{pages}</span></h4>
          {web.sites.map((site) => (
            <div key={site.site} className="stage-site">
              <strong>{site.site}</strong>
              <ul>
                {site.pages.map((page) => (
                  <li key={page.url}>
                    <a href={page.url} target="_blank" rel="noreferrer" title={page.url}>{titles.get(page.url) ?? (page.url.replace(/^https?:\/\/[^/]+/, '') || '/')}<ExternalLink size={12} aria-hidden="true" /><span className="visually-hidden"> (opens in your browser)</span></a>
                    {page.times > 1 && <span className="stage-times" aria-label={`read ${page.times} times`}>{page.times}×</span>}
                    {page.inAnswer && <span className="stage-cited"><Check size={12} aria-hidden="true" />In the answer</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
      {web.searches.length > 0 && (
        <section>
          <h4>Searches <span>{web.searches.length}</span></h4>
          {!kept && <p className="stage-muted">It didn’t keep what it searched for.</p>}
          <ul>
            {web.searches.map((search, index) => (
              <li key={index} className="stage-search">
                {search.query && <span>“{search.query}”</span>}
                {search.found.length > 0
                  ? <span className="stage-found">{search.found.slice(0, 2).map((hit) => <a key={hit.url} href={hit.url} target="_blank" rel="noreferrer">{hit.title}</a>)}{search.found.length > 2 && <span className="stage-muted">and {search.found.length - 2} more</span>}</span>
                  : <span className="stage-found stage-muted">No results kept</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {web.failedReads > 0 && <section><h4>Pages that came back empty <span>{web.failedReads}</span></h4><p className="stage-muted">Nothing came back from {web.failedReads === 1 ? 'one page' : `${web.failedReads} pages`}, so it couldn’t use {web.failedReads === 1 ? 'it' : 'them'}.</p></section>}
      {web.code > 0 && <section><h4>Programs it ran to search the web <span>{web.code}</span></h4><p className="stage-muted">To search and read the web, the model wrote small programs that ran on its AI company’s computers, not yours.</p></section>}
    </>
  )
}

/** The calls of one kind, each a way to its record in the inspector. */
export function UseList({ uses, evidence, onInspect }: { uses: readonly Use[]; evidence: readonly Evidence[]; onInspect: (id: string) => void }) {
  const at = new Map(evidence.map((item) => [item.id, item]))
  return (
    <ul className="stage-uses">
      {uses.map((use) => {
        const item = at.get(use.evidenceId)
        return (
          <li key={use.evidenceId}>
            <button type="button" className="stage-use" onClick={() => onInspect(use.evidenceId)}>
              <span>{use.label}</span>
              {item && <small>at {formatOffset(item.offsetMs)}{item.status === 'failed' || item.status === 'rejected' ? ' · failed' : ''}</small>}
              <ArrowRight size={13} aria-hidden="true" />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** How each route is described, in the daemon's own terms (ADR 0021). `native` keeps the text out of the prompt. */
const ROUTE_SENTENCE: Record<'native' | 'inline' | 'blocked', string> = {
  native: 'Native — the bundle sits in the agent’s skills folder and the prompt points at it.',
  inline: 'In-prompt, translated — it could not be relied on to run as written, so its body was inlined with a mapping note.',
  blocked: 'Blocked — this run had no skills folder for it.',
}

export interface SkillListProps {
  skills: SkillSummary
  planned: boolean
  /** The skill whose receipt is open, by its id. */
  open: string | null
  onOpen: (id: string | null) => void
  translationFor: (skill: string) => string | null
  selfReport: string | null
  /** Every agent's requirements and fingerprints were recorded by the run. */
  recorded: boolean
  /** Every skill it opened, as its tray counts them, required or not. */
  uses: readonly Use[]
  evidence: readonly Evidence[]
  onInspect: (id: string) => void
}

/** Its skills, each with what the run shows of it; one opens to its receipt. */
export function SkillList({ skills, planned, open, onOpen, translationFor, selfReport, recorded, uses, evidence, onInspect }: SkillListProps) {
  // A skill it opened that this agent was not given: another's, read on its own initiative.
  const given = new Set(skills.skills.map((skill) => skill.name))
  const others = uses.filter((use) => !given.has(use.label))
  return (
    <>
      {skills.required > 0 && (
        <p className="stage-muted stage-skill-check">
          {skillCount(skills, planned)}{!planned && !recorded && ' This run is older, so some details weren’t kept.'}
        </p>
      )}
      {skills.skills.length > 0 && (
        <ul className="stage-skills">
          {skills.skills.map((skill) => {
            const state = skillState(skill, planned)
            return (
              <li key={skill.id}>
                <button type="button" className={`stage-skill state-${skill.state}`} aria-expanded={open === skill.id} aria-label={`Inspect ${skill.name}: ${state}`} onClick={() => onOpen(open === skill.id ? null : skill.id)}>
                  <Sparkles size={14} aria-hidden="true" /><strong>{skill.name}</strong><span>{state}</span>
                </button>
                {open === skill.id && <SkillReceipt skill={skill} planned={planned} translation={translationFor(skill.name)} selfReport={selfReport} onInspect={onInspect} />}
              </li>
            )
          })}
        </ul>
      )}
      {others.length > 0 && <section><h4>Opened, not one of its own <span>{others.length}</span></h4><UseList uses={others} evidence={evidence} onInspect={onInspect} /></section>}
    </>
  )
}

/** What the run shows of one skill, in plain words first; the record's own facts under them. */
function SkillReceipt({ skill, planned, translation, selfReport, onInspect }: { skill: RunCapability; planned: boolean; translation: string | null; selfReport: string | null; onInspect: (id: string) => void }) {
  const receipt = skill.receipt
  const opened = skill.receipt?.state === 'opened' || skill.state === 'read'
  return (
    <div className="stage-skill-receipt">
      <p>
        {planned
          ? 'It gets this skill’s full instructions when it starts, and LoomWatch keeps a record of what it sent.'
          : givenInFull(skill)
            ? 'LoomWatch put this skill’s full instructions in what it sent the agent.'
            : skill.state === 'failed'
              ? 'The agent tried to open this skill but couldn’t. Open a record below to see why.'
              : opened
                ? 'The agent opened this skill’s instructions.'
                : skill.required
                  ? 'Nothing in this run shows it opening this skill.'
                  : 'Calls it made around this skill.'}
      </p>
      {receipt && (
        <dl className="delivery-skill-receipt">
          <dt>Skill source</dt><dd>{receipt.source}</dd>
          {receipt.harness && <><dt>Ran on</dt><dd>{receipt.harness}</dd></>}
          <dt>Instruction file</dt><dd>{receipt.path}</dd>
          <dt>Instructions fingerprint</dt><dd>{receipt.sha256}</dd>
          {receipt.route && <><dt>Route</dt><dd>{ROUTE_SENTENCE[receipt.route]}{receipt.needs?.length ? ` Needs: ${receipt.needs.join(', ')}.` : ' It assumes nothing the agent lacks.'}</dd></>}
          <dt>Opened by the agent</dt>
          <dd>{receipt.state === 'opened' ? 'Yes. Its own record shows it opening the file it was given.' : 'Not recorded. Being given a skill is not using it: nothing in this run shows it opening this one.'}</dd>
          <dt>Instructions</dt>
          <dd>{receipt.chars.toLocaleString()} characters · {receipt.state === 'prepared' ? 'prepared; send not yet recorded' : 'sent when it started'}<SuppliedInstructions receipt={receipt} /></dd>
        </dl>
      )}
      {translation && <div className="delivery-translation"><h4 className="t-body-m">What LoomWatch told this agent about running it here</h4><pre className="supplied-text t-mono-sm">{translation}</pre></div>}
      {selfReport && <div className="delivery-translation"><h4 className="t-body-m">What the agent said it could not follow</h4><p className="t-meta">In its own words. LoomWatch can’t confirm it.</p><pre className="supplied-text t-mono-sm">{selfReport}</pre></div>}
      {skill.evidence.map((item) => (
        <button type="button" className="delivery-receipt-row" key={item.id} onClick={() => onInspect(item.id)}>
          <span>#{item.order} · {formatOffset(item.offsetMs)}</span><strong>{item.name}</strong><span>{item.status} · {item.capture}</span><ArrowRight size={15} aria-hidden="true" />
        </button>
      ))}
    </div>
  )
}
