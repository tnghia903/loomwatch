import { useId } from 'react'

import type { Maker } from '../../lib/ai/makers'

/**
 * Gives each id inside a vendored mark (its gradients) this tile's own prefix, so two tiles of the
 * same maker on one page never point at each other's gradient: a gradient whose first copy sits in
 * a hidden list would draw nothing.
 */
function ownIds(svg: string, prefix: string): string {
  return svg
    .replace(/\bid="([^"]+)"/g, (_, id: string) => `id="${prefix}${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_, id: string) => `url(#${prefix}${id})`)
    .replace(/\bhref="#([^"]+)"/g, (_, id: string) => `href="#${prefix}${id}"`)
}

/**
 * The mark of the company that made a model, on a small tile, so the list says whose model a row
 * is before its name is read. A company's mark in its own colours where it has one, with its dark
 * version on the dark theme where it gives one; else its one-colour mark; else its first letter.
 * Decorative: the maker's name is always written beside it.
 */
export function MakerMark({ maker }: { maker: Maker }) {
  const prefix = `m${useId().replace(/[^a-zA-Z0-9_-]/g, '')}-`
  const { colour } = maker
  return (
    <span className={`maker-mark${colour ? ' colour' : maker.mark ? '' : ' letter'}`} aria-hidden="true">
      {colour
        ? <>
            {/* The vendored mark is fixed text from makerColours.ts, never anything a person or model wrote. */}
            <svg className={colour.dark ? 'on-light' : undefined} viewBox={colour.viewBox} dangerouslySetInnerHTML={{ __html: ownIds(colour.svg, prefix) }} />
            {colour.dark && <svg className="on-dark" viewBox={colour.viewBox} dangerouslySetInnerHTML={{ __html: ownIds(colour.dark, `${prefix}d-`) }} />}
          </>
        : maker.mark
          ? <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" clipRule="evenodd">{maker.mark.map((d, index) => <path key={index} d={d} />)}</svg>
          : <b>{maker.name.trim().charAt(0).toUpperCase() || '?'}</b>}
    </span>
  )
}
