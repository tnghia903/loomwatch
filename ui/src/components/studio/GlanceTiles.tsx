import { formatCost } from '../../lib/watch/usage'
import { relativeTime } from '../../lib/format'
import { baseName } from '../../lib/files/paths'
import { whenNext, type AtWork, type MonthSpend, type NeedsYouItem, type NextRun } from '../../lib/projects/glance'
import type { FigureOf } from '../../lib/projects/studioUi'
import type { RunRecord } from '../../lib/runs/client'
import { FigureStill } from '../agents/FigureStill'
import { FileChip } from '../ui/FileChip'

/** How many of what needs you a tile lists before "N more". */
const LISTED = 2

/** The waiting ring and the stop cross: the shape that says the state beside its colour and words. */
function NeedsShape({ kind }: { kind: NeedsYouItem['kind'] }) {
  return kind === 'waiting'
    ? <svg className="glance-shape waiting" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /></svg>
    : <svg className="glance-shape failed" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
}

/** What needs you, each with the one press that answers it; or, with nothing waiting, the last work that went well. */
function NeedsTile({ needs, last, figureOf, onReview, onTryAgain, onOpenLast, onMore }: Pick<GlanceProps, 'needs' | 'last' | 'figureOf' | 'onReview' | 'onTryAgain' | 'onOpenLast' | 'onMore'>) {
  if (needs.length === 0) {
    return (
      <section className="glance-tile" aria-labelledby="glance-last">
        <h3 id="glance-last" className="glance-label">{last ? `Last finished · ${relativeTime(new Date(last.run.finishedAt ?? last.run.createdAt))}` : 'Nothing waits for you'}</h3>
        {last && <button type="button" className="glance-ask" onClick={() => onOpenLast?.(last.run)}>{last.run.prompt}</button>}
        {last?.file && <FileChip path={last.file} />}
      </section>
    )
  }
  // The first answer is the screen's one gold fill: what waits for you is the thing to do now.
  const first = needs[0]
  return (
    <section className="glance-tile needs" aria-labelledby="glance-needs">
      <h3 id="glance-needs" className="glance-label">Needs you · {needs.length}</h3>
      <ul className="glance-needs">
        {needs.slice(0, LISTED).map((item) => (
          <li key={item.key}>
            <span className="desk-figure" data-glow={item.kind}><FigureStill figure={figureOf(item.seat)} alt="" width={34} height={34} decoding="async" /></span>
            <span className="glance-need-words">
              <span><NeedsShape kind={item.kind} />{item.seat.name} {item.says}</span>
              <small>{item.teamName}</small>
            </span>
            {item.kind === 'waiting'
              ? <button type="button" className={item === first ? 'btn btn-primary' : 'btn'} onClick={() => onReview(item)} aria-label={`Review: ${item.seat.name} ${item.says}`}>Review</button>
              : <button type="button" className="btn" onClick={() => onTryAgain(item)} aria-label={`Try again: ${item.teamName}`}>Try again</button>}
          </li>
        ))}
      </ul>
      {needs.length > LISTED && <button type="button" className="link glance-more" onClick={onMore}>{needs.length - LISTED} more</button>}
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
  spend: MonthSpend
  figureOf: FigureOf
  onReview: (item: NeedsYouItem) => void
  onTryAgain: (item: NeedsYouItem) => void
  /** Open the last work that went well, where it was given. */
  onOpenLast?: (run: RunRecord) => void
  onOpenWork?: (at: AtWork) => void
  onMore?: () => void
}

/**
 * The four tiles a room and Home open with, each always in its place (ADR 0097): what needs you,
 * who is working, what comes next (or, on Home, what finished today) and what this month cost.
 * Each says its state in words and a shape as well as colour, and what can be done is one press.
 */
export function GlanceTiles(props: GlanceProps) {
  const { label = 'At a glance', working, next, finishedToday, spend, figureOf, onOpenWork } = props
  const lead = working[0]
  return (
    <div className="glance" role="group" aria-label={label}>
      <NeedsTile {...props} />

      <section className="glance-tile" aria-labelledby="glance-working">
        <h3 id="glance-working" className="glance-label">Working now{working.length > 1 ? ` · ${working.length}` : ''}</h3>
        {lead ? (
          <button type="button" className="glance-agent" onClick={() => onOpenWork?.(lead)} aria-label={`${lead.seat.name} is working, in ${lead.teamName}. Open it`}>
            <span className="desk-figure" data-glow="working"><FigureStill figure={figureOf(lead.seat)} alt="" width={34} height={34} decoding="async" /></span>
            <span className="glance-need-words">
              <span><span className="glance-dot" aria-hidden="true" />{lead.seat.name} is working</span>
              <small>{lead.teamName} · {relativeTime(new Date(lead.since)).replace(' ago', '')}</small>
            </span>
          </button>
        ) : <p className="glance-quiet">Nobody is working.</p>}
        {working.length > 1 && <p className="glance-sub">and {working.slice(1, 3).map((at) => at.seat.name).join(', ')}{working.length > 3 ? ` and ${working.length - 3} more` : ''}</p>}
      </section>

      {finishedToday ? (
        <section className="glance-tile" aria-labelledby="glance-today">
          <h3 id="glance-today" className="glance-label">Finished today</h3>
          <p className="glance-number">{finishedToday.length}</p>
          <p className="glance-sub">{finishedToday.length > 0 ? finishedToday.slice(0, 2).map((run) => run.teamName ?? baseName(run.teamPath).replace(/\.ya?ml$/i, '')).join(', ') : 'Nothing yet today.'}</p>
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
        <p className="glance-number">{spend.atLeast && <small>at least </small>}{formatCost(spend.usd)}</p>
        <p className="glance-sub">{spend.runs} piece{spend.runs === 1 ? '' : 's'} of work</p>
      </section>
    </div>
  )
}
