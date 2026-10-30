import { useEffect, useState } from 'react'

import { listNames, relativeTime } from '../../lib/format'
import { costLines, elapsedWords, placeOf, whenNext, type AtWork, type DoneBy, type MonthCost, type MonthSpend, type NeedsYouItem, type NextRun, type Spender } from '../../lib/projects/glance'
import type { Seat } from '../../lib/projects/studio'
import { seatWords } from '../../lib/projects/studio'
import type { FigureOf } from '../../lib/projects/studioUi'
import type { RunRecord } from '../../lib/runs/client'
import { useNow } from '../../lib/useNow'
import { formatCost } from '../../lib/watch/usage'
import { FigureStill } from '../agents/FigureStill'
import { FileChip } from '../ui/FileChip'
import { Icon } from '../ui/icon'

/** How many of what needs you a tile lists before "N more". */
const LISTED = 2
/** How many of the agents Working now draws while nobody works, before "+N". */
const CREW = 5
/** How many others at work are named under the one drawn big. */
const ALSO = 2
/** How many of today's pieces of work are drawn as their agents, before "+N". */
const HEADS = 6
/** How many agents the month's split names under its bar; the rest are one part. */
const SPENDERS = 3

/** The waiting ring and the stop cross: the shape that says the state beside its colour and words. */
function NeedsShape({ kind }: { kind: NeedsYouItem['kind'] }) {
  return kind === 'waiting'
    ? <svg className="glance-shape waiting" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /></svg>
    : <svg className="glance-shape failed" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
}

/**
 * The one press that answers an item: Approve for work to check, with its work one press away to
 * read first; Answer for a question, a permission or a limit; for work that stopped, the fix
 * LoomWatch knows for why (adding credits, say), or See why, which opens it where it stopped. The
 * first item's is the screen's one gold fill.
 */
function ItemAction({ item, primary, busy, onApprove, onReview, onOpenRun }: { item: NeedsYouItem; primary: boolean; busy: boolean; onApprove?: (item: NeedsYouItem) => void; onReview: GlanceProps['onReview']; onOpenRun: GlanceProps['onOpenRun'] }) {
  const className = primary ? 'btn btn-primary' : 'btn'
  if (item.kind === 'waiting' && item.asks === 'check' && onApprove) {
    return (
      <span className="glance-acts">
        <button type="button" className="iconbtn glance-read" onClick={() => onReview(item)} aria-label={`Read ${item.seat.name}’s work first`} title="Read it first"><Icon name="page" size={16} /></button>
        <button type="button" className={className} disabled={busy} onClick={() => onApprove(item)} aria-label={`Approve: ${item.seat.name} ${item.says}`}>Approve</button>
      </span>
    )
  }
  if (item.kind === 'waiting') {
    const verb = item.asks === 'check' ? 'Approve' : 'Answer'
    return <button type="button" className={className} onClick={() => onReview(item)} aria-label={`${verb}: ${item.seat.name} ${item.says}`}>{verb}</button>
  }
  if (item.fix) {
    return <a className={className} href={item.fix.href} {...(item.fix.external ? { target: '_blank', rel: 'noreferrer' } : {})}>{item.fix.label}</a>
  }
  return <button type="button" className={className} onClick={() => onOpenRun(item)} aria-label={`See why ${item.teamName} didn’t finish`}>See why</button>
}

/**
 * What needs you, each with the one press that answers it; or, with nothing waiting, the last work
 * that went well: who did it, drawn big, and what they were asked.
 */
const STEPPED_UP = 'loomwatch:stepped-up'

const steppedUpBefore = (key: string) => {
  try { return window.sessionStorage.getItem(STEPPED_UP) === key } catch { return false }
}

/**
 * The key of the item that steps up when it is new to this tab, so its figure pops once on arrival
 * and not again on every visit to Home (motion.css). Remembered for the tab, where storage allows;
 * worked out as the item changes, so the pop is never taken back while it plays.
 */
function usePoppedOnce(key: string | null): string | null {
  const [popped, setPopped] = useState(() => ({ key, isNew: key !== null && !steppedUpBefore(key) }))
  if (popped.key !== key) setPopped({ key, isNew: key !== null && !steppedUpBefore(key) })
  useEffect(() => {
    if (key) try { window.sessionStorage.setItem(STEPPED_UP, key) } catch { /* no storage: it pops each visit */ }
  }, [key])
  return popped.isNew ? popped.key : null
}

function NeedsTile({ needs, last, doneBy, figureOf, onApprove, onReview, onOpenRun, onMore, stepUp = false }: Pick<GlanceProps, 'needs' | 'last' | 'doneBy' | 'figureOf' | 'onApprove' | 'onReview' | 'onOpenRun' | 'onMore' | 'stepUp'>) {
  const [all, setAll] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [said, setSaid] = useState('')
  const upKey = stepUp ? needs[0]?.key ?? null : null
  const popped = usePoppedOnce(upKey)
  const approve = onApprove && (async (item: NeedsYouItem) => {
    setBusy(item.key)
    setSaid('')
    try {
      if (await onApprove(item)) setSaid(`Approved. ${item.teamName} carries on.`)
    } catch (caught) {
      setSaid(`Couldn’t approve: ${caught instanceof Error ? caught.message : String(caught)}`)
    } finally {
      setBusy(null)
    }
  })
  if (needs.length === 0) {
    const by = last ? doneBy(last.run) : null
    return (
      <section className="glance-tile" aria-labelledby="glance-last">
        <h3 id="glance-last" className="glance-label">{last ? `Last finished · ${relativeTime(new Date(last.run.finishedAt ?? last.run.createdAt))}` : 'Nothing is waiting for you'}</h3>
        {last && by && (
          <div className="glance-last">
            {/* The figure alone, unlit: it says who did the work, not what it is doing now. */}
            <span className="desk-figure"><FigureStill figure={figureOf(by.seat)} alt="" width={56} height={56} decoding="async" /></span>
            <span className="glance-last-words">
              <button type="button" className="glance-ask" onClick={() => onOpenRun(last.run)} aria-label={`Open ${by.seat.name}’s work: ${last.run.prompt}`}>{last.run.prompt}</button>
              {/* "answered", so the figure beside a question doesn't read as the agent asking you. */}
              <small>{by.seat.name} answered · {by.place}</small>
            </span>
          </div>
        )}
        {last?.file && <FileChip path={last.file} />}
        <p className="glance-said t-meta" aria-live="polite">{said}</p>
      </section>
    )
  }
  const listed = all ? needs : needs.slice(0, LISTED)
  const more = needs.length - listed.length
  return (
    <section className="glance-tile needs" aria-labelledby="glance-needs">
      <h3 id="glance-needs" className="glance-label">Needs you · {needs.length}</h3>
      <ul className="glance-needs">
        {listed.map((item, index) => (
          // On Home the first steps up: the one that needs you most, drawn big, its line first.
          <li key={item.key} className={stepUp && index === 0 ? 'glance-up' : undefined} data-new={stepUp && index === 0 && popped === item.key ? true : undefined}>
            <span className="desk-figure" data-glow={item.kind}><FigureStill figure={figureOf(item.seat)} alt="" width={stepUp && index === 0 ? 88 : 44} height={stepUp && index === 0 ? 88 : 44} decoding="async" /></span>
            <span className="glance-need-words">
              <span><NeedsShape kind={item.kind} />{item.seat.name} {item.says}</span>
              <small title={item.reason}>{item.reason ? `${item.teamName} · ${item.reason}` : item.teamName}</small>
            </span>
            <ItemAction item={item} primary={index === 0} busy={busy === item.key} onApprove={approve} onReview={onReview} onOpenRun={onOpenRun} />
          </li>
        ))}
      </ul>
      {/* Home's bell lists them all; a room, which has no bell, shows them here. */}
      {more > 0 && <button type="button" className="link glance-more" onClick={() => (onMore ? onMore() : setAll(true))}>Show {more} more</button>}
      <p className="glance-said t-meta" aria-live="polite">{said}</p>
    </section>
  )
}

/** Words joined with no-break spaces, so a line breaks only between parts, at "·". */
const unbroken = (words: string) => words.replaceAll(' ', '\u00a0')

/**
 * "Nobody is working · all 4 ready": how many of the agents drawn are free for work. An agent can
 * be at work in a run that waits for you, which Working now leaves to Needs you: then the words
 * name who works rather than say nobody does.
 */
function readyWords(crew: readonly Seat[]): string {
  const ready = crew.filter((seat) => seat.state === 'ready' && !seat.away).length
  const all = ready === crew.length
  const count = ready === 0 ? null : unbroken(all && ready === 2 ? 'both ready' : `${all && ready > 2 ? 'all ' : ''}${ready} ready`)
  const busy = crew.filter((seat) => seat.state === 'working' && !seat.away).map((seat) => seat.name)
  if (busy.length > 0) return [`${listNames(busy)} ${busy.length === 1 ? 'is' : 'are'} working`, count].filter(Boolean).join(' · ')
  return count ? `Nobody is working · ${count}` : 'Nobody is working.'
}

/** Who to draw first: whoever waits for you, then whoever works, then the rest. */
const FIRST: Record<Seat['state'], number> = { waiting: 0, working: 1, failed: 2, ready: 3 }

/**
 * Who is working, the longest at it drawn big with what they were given, each one press from its
 * work; while nobody works, the agents themselves, each lit as it is now.
 */
function WorkingTile({ working, crew, figureOf, onOpenRun }: Pick<GlanceProps, 'working' | 'crew' | 'figureOf' | 'onOpenRun'>) {
  const now = useNow(working.length > 0)
  const [lead, ...others] = working
  const named = (at: AtWork) => `${at.seat.name} is working on “${at.prompt}”, in ${placeOf(at)}. Open it`
  // The name and the team kept whole; the time may wrap, as on a phone it is wider than its column.
  const line = (at: AtWork) => [unbroken(at.seat.name), unbroken(placeOf(at)), elapsedWords(at.since, now)].join(' · ')
  const drawn = [...crew].sort((left, right) => (left.away ? 4 : FIRST[left.state]) - (right.away ? 4 : FIRST[right.state]))
  return (
    <section className="glance-tile" aria-labelledby="glance-working">
      <h3 id="glance-working" className="glance-label">Working now{working.length > 1 ? ` · ${working.length}` : ''}</h3>
      {lead ? (
        <>
          <button type="button" className="glance-agent glance-lead" onClick={() => onOpenRun(lead)} aria-label={named(lead)}>
            <span className="desk-figure" data-glow="working"><FigureStill figure={figureOf(lead.seat)} alt="" width={52} height={52} decoding="async" /></span>
            <span className="glance-need-words">
              <span className="glance-doing">{lead.prompt}</span>
              <small>{line(lead)}</small>
            </span>
          </button>
          {others.slice(0, ALSO).map((at) => (
            <button key={at.key} type="button" className="glance-agent" onClick={() => onOpenRun(at)} aria-label={named(at)}>
              <span className="desk-figure" data-glow="working"><FigureStill figure={figureOf(at.seat)} alt="" width={26} height={26} decoding="async" /></span>
              <span className="glance-need-words"><small>{line(at)}</small></span>
            </button>
          ))}
          {others.length > ALSO && <p className="glance-sub">and {others.length - ALSO} more</p>}
        </>
      ) : crew.length > 0 ? (
        <>
          {/* The words first: four figures lit under "Working now" would read as four at work. */}
          <p className="glance-sub">{readyWords(crew)}</p>
          <ul className="glance-crew" aria-label="Agents">
            {drawn.slice(0, CREW).map((seat, index) => (
              <li key={`${index}:${seat.id}`} title={seatWords(seat)}>
                <span className={`desk-figure${seat.away ? ' away' : ''}`} data-glow={seat.away ? undefined : seat.state}>
                  <FigureStill figure={figureOf(seat)} alt={seatWords(seat)} width={36} height={36} decoding="async" />
                </span>
              </li>
            ))}
            {crew.length > CREW && <li className="glance-sub" aria-label={`${crew.length - CREW} more agents`}>+{crew.length - CREW}</li>}
          </ul>
        </>
      ) : <p className="glance-quiet">Nobody is working.</p>}
    </section>
  )
}

/** Today's finished work: how much, and each piece as the agent who answered it, one press from it. */
function TodayTile({ finishedToday, doneBy, figureOf, onOpenRun }: Pick<GlanceProps, 'doneBy' | 'figureOf' | 'onOpenRun'> & { finishedToday: readonly RunRecord[] }) {
  const places = [...new Set(finishedToday.map((run) => doneBy(run).place))]
  return (
    <section className="glance-tile" aria-labelledby="glance-today">
      <h3 id="glance-today" className="glance-label">Finished today</h3>
      <div className="glance-today">
        <p className="glance-number">{finishedToday.length}</p>
        {finishedToday.length > 0 && (
          <ul className="glance-heads" aria-label="Today’s finished work">
            {finishedToday.slice(0, HEADS).map((run) => {
              const { seat: by } = doneBy(run)
              const at = new Date(run.finishedAt ?? run.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
              return (
                <li key={run.runId}>
                  <button type="button" title={`${by.name} finished at ${at}: “${run.prompt}”`} aria-label={`Open ${by.name}’s work: ${run.prompt}`} onClick={() => onOpenRun(run)}>
                    <FigureStill figure={figureOf(by)} alt="" width={30} height={30} decoding="async" />
                  </button>
                </li>
              )
            })}
            {finishedToday.length > HEADS && <li className="glance-sub" aria-label={`${finishedToday.length - HEADS} more pieces of work`}>+{finishedToday.length - HEADS}</li>}
          </ul>
        )}
      </div>
      <p className="glance-sub">{places.length > 0 ? `${places.slice(0, 2).join(', ')}${places.length > 2 ? ` and ${places.length - 2} more` : ''}` : 'Nothing yet today.'}</p>
    </section>
  )
}

/**
 * This month's dollars by agent: a bar split in their shares, and under it each part's key, the
 * costliest by figure, then everything else. Each part grows by its share of the whole, so the bar
 * is always full: grown by dollars, a month under $1 would fill a part of it and read as a limit
 * half used. Ask and LoomWatch's own reading of messages are in everything else, as no agent's.
 * A bar of one part says nothing its figure doesn't, so it is drawn from two.
 */
function MonthSplit({ cost, spenders, figureOf }: { cost: MonthCost; spenders: readonly Spender[]; figureOf: FigureOf }) {
  const named = spenders.slice(0, SPENDERS)
  const rest = cost.usd - named.reduce((sum, spender) => sum + spender.usd, 0)
  const share = (usd: number) => usd / Math.max(cost.usd, named.reduce((sum, spender) => sum + spender.usd, 0))
  const restShown = share(rest) >= 0.01
  const bar = named.length + (restShown ? 1 : 0) > 1
  const dollars = (spender: Spender) => `${spender.estimated ? '≈ ' : ''}${formatCost(spender.usd)}`
  return (
    <>
      {bar && (
        <div className="glance-split" aria-hidden="true">
          {named.map((spender, index) => <span key={spender.key} data-part={index} style={{ flexGrow: share(spender.usd) }} title={`${spender.seat.name} · ${dollars(spender)}`} />)}
          {restShown && <span data-part="rest" style={{ flexGrow: share(rest) }} title={`Everything else · ${formatCost(rest)}`} />}
        </div>
      )}
      <ul className="glance-spenders" aria-label="Who spent it">
        {named.map((spender, index) => (
          <li key={spender.key} title={`${spender.seat.name} · ${dollars(spender)}`}>
            {bar && <span className="glance-key" data-part={index} aria-hidden="true" />}
            <FigureStill figure={figureOf(spender.seat)} alt={spender.seat.name} width={24} height={24} decoding="async" />
            {dollars(spender)}
          </li>
        ))}
        {restShown && (
          <li>
            <span className="glance-key" data-part="rest" aria-hidden="true" />
            <span className="glance-else">Everything else</span> {formatCost(rest)}
          </li>
        )}
      </ul>
    </>
  )
}

export interface GlanceProps {
  /** What the row is called to a screen reader: Home's is Your desk. */
  label?: string
  needs: readonly NeedsYouItem[]
  /** The last work that went well and what it made first, shown when nothing needs you. */
  last: { run: RunRecord; file: string | null } | null
  working: readonly AtWork[]
  /** The agents at the teams' desks, as each is now, drawn while nobody works. */
  crew: readonly Seat[]
  /** A room's next scheduled runs; Home shows what finished today instead. */
  next?: readonly NextRun[]
  finishedToday?: readonly RunRecord[]
  /** This month's runs, counted from the runs themselves. */
  spend: MonthSpend
  /** This month's cost by where it was paid, when the usage report could be read. */
  cost: MonthCost | null
  /** Who this month's dollars went to, costliest first. */
  spenders: readonly Spender[]
  /** Who gave a run's answer, to draw it, and where the work was given. */
  doneBy: (run: RunRecord) => DoneBy
  figureOf: FigureOf
  /** Read an item's work first: where it waits (the bell's tray on Home, its run in a room). */
  onReview: (item: NeedsYouItem) => void
  /** Approve work waiting to be checked, in one press; true once it is approved. Without it,
      Approve opens the work, as onReview does. */
  onApprove?: (item: NeedsYouItem) => Promise<boolean>
  /** Open a piece of work where it was given: its team's chat, at that work. */
  onOpenRun: (run: Pick<RunRecord, 'runId' | 'teamPath'>) => void
  /** Show everything that needs you; without it the tile lists the rest itself. */
  onMore?: () => void
  /** Home, the quiet desk (ADR 0101): what needs you spans the row, and its first item steps up. */
  stepUp?: boolean
}

/**
 * The four tiles a room and Home open with, each always in its place (ADR 0097): what needs you,
 * who is working, what comes next (or, on Home, what finished today) and what this month cost.
 * The agents are drawn big, as who did what: lit only where the figure says what it is doing now.
 * Each says its state in words and a shape as well as colour, and what can be done is one press.
 */
export function GlanceTiles(props: GlanceProps) {
  const { label = 'At a glance', next, finishedToday, spend, cost, spenders, figureOf } = props
  const lines = cost ? costLines(cost) : null
  return (
    <div className={`glance${props.stepUp ? ' glance-home' : ''}`} role="group" aria-label={label}>
      <NeedsTile {...props} />

      <WorkingTile {...props} />

      {finishedToday ? <TodayTile {...props} finishedToday={finishedToday} /> : (
        <section className="glance-tile" aria-labelledby="glance-next">
          <h3 id="glance-next" className="glance-label">Next</h3>
          {next && next.length > 0 ? (
            <>
              <p className="glance-main">{next[0].teamName}</p>
              <p className="glance-sub">{whenNext(next[0].at)}</p>
              {next[1] && <p className="glance-sub">then {next[1].teamName}, {whenNext(next[1].at)}</p>}
            </>
          ) : <p className="glance-quiet">Nothing on a schedule.</p>}
        </section>
      )}

      <section className="glance-tile" aria-labelledby="glance-month">
        <h3 id="glance-month" className="glance-label">This month</h3>
        {cost && lines ? (
          <div>
            <p className="glance-number" title={cost.estimated ? 'About: part of it is worked out from list prices' : undefined}>{lines.main}</p>
            {lines.plan && <p className="glance-sub">{lines.plan}</p>}
          </div>
        ) : <p className="glance-number">{spend.atLeast && <small>at least </small>}{formatCost(spend.usd)}</p>}
        {cost && cost.usd > 0 && spenders.length > 0 && <MonthSplit cost={cost} spenders={spenders} figureOf={figureOf} />}
        <p className="glance-sub">{spend.runs} piece{spend.runs === 1 ? '' : 's'} of work</p>
      </section>
    </div>
  )
}
