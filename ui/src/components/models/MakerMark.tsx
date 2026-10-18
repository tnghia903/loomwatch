import type { Maker } from '../../lib/ai/makers'

/**
 * The mark of the company that made a model, on a small tile, so the list says whose model a row
 * is before its name is read. A maker with no mark shows its first letter. Decorative: the maker's
 * name is always written beside it.
 */
export function MakerMark({ maker }: { maker: Maker }) {
  return (
    <span className={`maker-mark${maker.mark ? '' : ' letter'}`} aria-hidden="true">
      {maker.mark
        ? <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" clipRule="evenodd">{maker.mark.map((d, index) => <path key={index} d={d} />)}</svg>
        : <b>{maker.name.trim().charAt(0).toUpperCase() || '?'}</b>}
    </span>
  )
}
