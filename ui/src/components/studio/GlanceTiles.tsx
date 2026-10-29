import { useState } from 'react'

import { relativeTime } from '../../lib/format'
import { baseName } from '../../lib/files/paths'
import { costWords, whenNext, type AtWork, type MonthCost, type MonthSpend, type NeedsYouItem, type NextRun } from '../../lib/projects/glance'
import type { FigureOf } from '../../lib/projects/studioUi'
import type { RunRecord } from '../../lib/runs/client'
import { formatCost } from '../../lib/watch/usage'
import { FigureStill } from '../agents/FigureStill'
import { FileChip } from '../ui/FileChip'
import { Icon } from '../ui/icon'

/** How many of what needs you a tile lists before "N more". */
const LISTED = 2

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

/** What needs you, each with the one press that answers it; or, with nothing waiting, the last work that went well. */
function NeedsTile({ needs, last, figureOf, onApprove, onReview, onOpenRun, onMore }: Pick<GlanceProps, 'needs' | 'last' | 'figureOf' | 'onApprove' | 'onReview' | 'onOpenRun' | 'onMore'>) {
  const [all, setAll] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [said, setSaid] = useState('')
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
    return (
      <section className="glance-tile" aria-labelledby="glance-last">
        <h3 id="glance-last" className="glance-label">{last ? `Last finished · ${relativeTime(new Date(last.run.finishedAt ?? last.run.createdAt))}` : 'Nothing is waiting for you'}</h3>
        {last && <button type="button" className="glance-ask" onClick={() => onOpenRun(last.run)}>{last.run.prompt}</button>}
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
          <li key={item.key}>
            <span className="desk-figure" data-glow={item.kind}><FigureStill figure={figureOf(item.seat)} alt="" width={34} height={34} decoding="async" /></span>
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

export interface GlanceProps {
  /** What the row is called to a screen reader: Home's is Your desk. */
  label?: string
  needs: readonly NeedsYouItem[]
  /** The last work that went well and what it made first, shown when nothing needs you. */
  last: { run: RunRecord; file: string | null } | null
  working: readonly AtWork[]
  /** A room's next scheduled runs; Home shows what finished today instead. */
  next?: readonly NextRun[]
  finishedToday?: readonly RunRecord[]
  /** This month's runs, counted from the runs themselves. */
  spend: MonthSpend
  /** This month's cost by where it was paid, when the usage report could be read. */
  cost: MonthCost | null
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
}

/**
 * The four tiles a room and Home open with, each always in its place (ADR 0097): what needs you,
 * who is working, what comes next (or, on Home, what finished today) and what this month cost.
 * Each says its state in words and a shape as well as colour, and what can be done is one press.
 */
export function GlanceTiles(props: GlanceProps) {
  const { label = 'At a glance', working, next, finishedToday, spend, cost, figureOf, onOpenRun } = props
  const lead = working[0]
  const today = [...new Set((finishedToday ?? []).map((run) => run.teamName ?? baseName(run.teamPath).replace(/\.ya?ml$/i, '')))]
  return (
    <div className="glance" role="group" aria-label={label}>
      <NeedsTile {...props} />

      <section className="glance-tile" aria-labelledby="glance-working">
        <h3 id="glance-working" className="glance-label">Working now{working.length > 1 ? ` · ${working.length}` : ''}</h3>
        {lead ? (
          <button type="button" className="glance-agent" onClick={() => onOpenRun(lead)} aria-label={`${lead.seat.name} is working, in ${lead.teamName}. Open it`}>
            <span className="desk-figure" data-glow="working"><FigureStill figure={figureOf(lead.seat)} alt="" width={34} height={34} decoding="async" /></span>
            <span className="glance-need-words">
              <span><span className="glance-dot" aria-hidden="true" />{lead.seat.name} is working</span>
              <small>{lead.teamName} · started {relativeTime(new Date(lead.since))}</small>
            </span>
          </button>
        ) : <p className="glance-quiet">Nobody is working.</p>}
        {working.length > 1 && <p className="glance-sub">and {working.slice(1, 3).map((at) => at.seat.name).join(', ')}{working.length > 3 ? ` and ${working.length - 3} more` : ''}</p>}
      </section>

      {finishedToday ? (
        <section className="glance-tile" aria-labelledby="glance-today">
          <h3 id="glance-today" className="glance-label">Finished today</h3>
          <p className="glance-number">{finishedToday.length}</p>
          <p className="glance-sub">{today.length > 0 ? `${today.slice(0, 2).join(', ')}${today.length > 2 ? ` and ${today.length - 2} more` : ''}` : 'Nothing yet today.'}</p>
        </section>
      ) : (
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
        {cost
          ? <p className="glance-number">{costWords(cost)}</p>
          : <p className="glance-number">{spend.atLeast && <small>at least </small>}{formatCost(spend.usd)}</p>}
        <p className="glance-sub">{spend.runs} piece{spend.runs === 1 ? '' : 's'} of work</p>
      </section>
    </div>
  )
}
