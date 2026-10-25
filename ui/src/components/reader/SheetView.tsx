import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'

import { cellAt, cellsCopied, inRange, rangeBetween, sheetColumns, type CellRange, type Sheet } from '../../lib/files/cells'
import { isNumberCell } from '../../lib/files/table'

/** A range asked about on a sheet, by its part's id (`partId`), with how its asks look. */
export interface SheetRange {
  id: string
  /** The sheet it is on, by name; `null` for a file of one sheet. */
  sheet: string | null
  range: CellRange
  look: string
}

/** A range marked now: where it is, and on which sheet. */
export interface MarkedCells {
  sheet: string | null
  range: CellRange
  /** Where its cells are on screen, for the ask bubble. */
  rect: { top: number; bottom: number; left: number; right: number }
}

interface SheetViewProps {
  sheets: readonly Sheet[]
  /** Cells can be asked about: a drag marks a range; a column's name or a row's number its whole column or row. */
  askable: boolean
  /** The ranges asked about, each drawn with a slot for its bubbles beside it. */
  ranges: readonly SheetRange[]
  /** The range marked now and not yet asked about. */
  marking: { sheet: string | null; range: CellRange } | null
  /** The part in the message box now, by its id. */
  asking: string | null
  /** The part whose answer is open, by its id: its sheet is shown. */
  open: string | null
  /** The page under the sheet is dark: the bubbles take its lightness, as they do after words. */
  dark: boolean
  onMarked: (marked: MarkedCells | null) => void
  /** Cells asked about were clicked: the answer of the newest ask on them opens. */
  onOpen: (id: string) => void
  /** Where a workbook's tabs go: above the scrolling sheet, so they never scroll away. */
  tabsInto?: HTMLElement | null
  /**
   * The ranges have been placed on their cells: measure them. The reader can't tell on its own when
   * another sheet's tab is chosen, or the sheet is laid out anew.
   */
  onDrawn?: () => void
}

type Corner = { row: number; column: number }
/** What a drag started on: a cell, a column's name (whole columns), or a row's number (whole rows). */
type Start = 'cell' | 'column' | 'row'
type Placed = { id: string; range: CellRange; className: string; away: boolean }

/** Room beside the sheet for the bubbles of a range at its last column: two agents' worth. */
const GUTTER_PX = 96

/**
 * A sheet an agent made, as a spreadsheet shows it (ADR 0091): a CSV or TSV file, or each sheet of
 * a workbook behind its tab, its first row as the column names and its rows numbered, numbers set
 * right. Drag across cells, or across column names or row numbers for whole columns or rows (a
 * press, or Enter, marks one), and the ask bubble leans in over them, as it does over marked words
 * (ADR 0077); ⌘C copies what is marked. Each range asked about stays drawn on the sheet, with the
 * bubble of each agent asked beside it, which opens the answer as a press on its cells does.
 */
export function SheetView({ sheets, askable, ranges, marking, asking, open, dark, onMarked, onOpen, tabsInto, onDrawn }: SheetViewProps) {
  const [shownName, setShownName] = useState<string | null>(sheets[0]?.name ?? null)
  const sheet = sheets.find((each) => each.name === shownName) ?? sheets[0]
  // The answer opened for cells on another sheet shows that sheet, once, when it opens.
  const openSheet = open ? ranges.find((range) => range.id === open)?.sheet : undefined
  const [seenOpen, setSeenOpen] = useState<string | null | undefined>(undefined)
  if (openSheet !== seenOpen) {
    setSeenOpen(openSheet)
    if (openSheet !== undefined && openSheet !== shownName && sheets.some((each) => each.name === openSheet)) setShownName(openSheet)
  }

  const grid = useRef<HTMLDivElement>(null)
  const columns = sheet ? sheetColumns(sheet) : 0
  const lastRow = sheet ? sheet.firstRow + sheet.rows.length - 1 : 0
  const lastColumn = sheet ? sheet.firstColumn + columns - 1 : 0
  // The first row names the columns: it goes with the cells asked about, and is never marked itself.
  const firstMarked = sheet && sheet.rows.length > 1 ? sheet.firstRow + 1 : sheet?.firstRow ?? 1
  const [drawing, setDrawing] = useState<{ from: Corner; to: Corner; pointer: number; start: Start } | null>(null)
  // The cell under the pointer: while the grid holds the pointer, the event's target is the grid.
  const cellOf = (event: PointerEvent<HTMLDivElement>): Corner | null => {
    const under = (typeof document.elementFromPoint === 'function' ? document.elementFromPoint(event.clientX, event.clientY) : null) ?? (event.target as Element)
    // A row's number stands for its row, at the sheet's first column.
    const row = under.closest<HTMLElement>('[data-whole-row]')
    if (row && grid.current?.contains(row)) return { row: Number(row.dataset.wholeRow), column: sheet?.firstColumn ?? 1 }
    const cell = under.closest<HTMLElement>('[data-row][data-column]')
    if (!cell || !grid.current?.contains(cell)) return null
    return { row: Number(cell.dataset.row), column: Number(cell.dataset.column) }
  }
  const cellBox = (row: number, column: number) => grid.current?.querySelector<HTMLElement>(`td[data-row="${row}"][data-column="${column}"], th[data-row="${row}"][data-column="${column}"]`) ?? null
  /** What a drag from one corner to another marks, by where it started; never the column names' row. */
  const rangeOf = (from: Corner, to: Corner, start: Start): CellRange => {
    const range = rangeBetween(from, to)
    if (start === 'column') return { top: firstMarked, bottom: lastRow, left: range.left, right: range.right }
    if (start === 'row') return { top: Math.max(firstMarked, range.top), bottom: Math.max(firstMarked, range.bottom), left: sheet?.firstColumn ?? 1, right: lastColumn }
    return { ...range, top: Math.max(firstMarked, range.top), bottom: Math.max(firstMarked, range.bottom) }
  }
  const mark = (range: CellRange) => {
    const first = cellBox(range.top, range.left)?.getBoundingClientRect()
    const last = cellBox(range.bottom, range.right)?.getBoundingClientRect()
    if (!first || !last || !sheet) return
    onMarked({ sheet: sheet.name, range, rect: { top: first.top, left: first.left, bottom: last.bottom, right: last.right } })
  }

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (!askable || !sheet || event.button !== 0 || (event.target as Element).closest('.rd-slot')) return
    const target = event.target as Element
    const row = target.closest<HTMLElement>('[data-whole-row]')
    const cell = row ? { row: Number(row.dataset.wholeRow), column: sheet.firstColumn } : cellOf(event)
    if (!cell) return
    event.preventDefault()
    grid.current?.setPointerCapture?.(event.pointerId)
    const start: Start = row ? 'row' : target.closest('thead th[data-row]') ? 'column' : 'cell'
    setDrawing({ from: cell, to: cell, pointer: event.pointerId, start })
    onMarked(null)
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (drawing?.pointer !== event.pointerId) return
    const cell = cellOf(event)
    if (cell && (cell.row !== drawing.to.row || cell.column !== drawing.to.column)) setDrawing({ ...drawing, to: cell })
  }
  const up = (event: PointerEvent<HTMLDivElement>) => {
    if (drawing?.pointer !== event.pointerId || !sheet) return
    setDrawing(null)
    const to = cellOf(event) ?? drawing.to
    if (drawing.start === 'cell' && to.row === drawing.from.row && to.column === drawing.from.column) {
      // A press on cells asked about opens the newest ask's answer; on any other cell it marks it.
      const asked = ranges.findLast((each) => each.sheet === sheet.name && inRange(each.range, to.row, to.column))
      if (asked) { onOpen(asked.id); return }
    }
    mark(rangeOf(drawing.from, to, drawing.start))
  }
  // From the keyboard: a column's name or a row's number, pressed with Enter or Space.
  const wholeColumn = (column: number) => mark({ top: firstMarked, bottom: lastRow, left: column, right: column })
  const wholeRow = (row: number) => mark({ top: row, bottom: row, left: sheet?.firstColumn ?? 1, right: lastColumn })

  // ⌘C copies the marked cells, by row and tab, as a spreadsheet does: nothing in a sheet is
  // selected as words while cells can be marked.
  useEffect(() => {
    if (!marking || !sheet || marking.sheet !== sheet.name) return
    const copy = (event: ClipboardEvent) => {
      if (document.getSelection()?.isCollapsed === false || !event.clipboardData) return
      event.clipboardData.setData('text/plain', cellsCopied(sheet, marking.range))
      event.preventDefault()
    }
    document.addEventListener('copy', copy)
    return () => document.removeEventListener('copy', copy)
  }, [marking, sheet])

  // The ranges asked about, the one marked and the one being dragged, drawn over their cells. Which
  // ranges there are comes from the props; where each sits is the cells' own place on screen, set
  // on the drawn box once the sheet is laid out, and again whenever it is laid out anew.
  const live = drawing ? rangeOf(drawing.from, drawing.to, drawing.start) : null
  // A range at the sheet's last row and column takes the table's rounded corner.
  const corner = (range: CellRange) => (range.bottom === lastRow && range.right === lastColumn ? ' corner' : '')
  const sheetName = sheet?.name ?? null
  const now = live ?? (marking && marking.sheet === sheetName ? marking.range : null)
  const placed: Placed[] = [
    // Cells on another sheet are not lost: their sheet's tab shows them.
    ...ranges.map((each) => ({ id: each.id, range: each.range, away: each.sheet !== sheetName, className: `rd-box rd-range ${each.look}${each.id === asking ? ' asking' : ''}${corner(each.range)}` })),
    ...(now ? [{ id: '', range: now, away: false, className: `rd-box rd-range ${live ? 'drawing' : 'marking'}${corner(now)}` }] : []),
  ]
  const placedKey = JSON.stringify(placed)
  const drawn = useRef(onDrawn)
  useEffect(() => { drawn.current = onDrawn }, [onDrawn])
  useLayoutEffect(() => {
    const element = grid.current
    if (!element) return
    const place = () => {
      const outer = element.getBoundingClientRect()
      for (const box of element.querySelectorAll<HTMLElement>(':scope > .rd-range[data-range]')) {
        const range = JSON.parse(box.dataset.range ?? 'null') as CellRange | null
        const first = range && cellBox(range.top, range.left)?.getBoundingClientRect()
        const last = range && cellBox(range.bottom, range.right)?.getBoundingClientRect()
        if (!first || !last) continue
        box.style.left = `${first.left - outer.left + element.scrollLeft}px`
        box.style.top = `${first.top - outer.top + element.scrollTop}px`
        box.style.width = `${last.right - first.left}px`
        box.style.height = `${last.bottom - first.top}px`
      }
      drawn.current?.()
    }
    place()
    if (typeof ResizeObserver === 'undefined') return
    const resized = new ResizeObserver(place)
    resized.observe(element)
    return () => resized.disconnect()
  }, [placedKey, sheet]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!sheet) return <p className="rd-empty">This sheet is empty.</p>
  const columnNumbers = Array.from({ length: columns }, (_, index) => sheet.firstColumn + index)
  const [head, ...body] = sheet.rows
  // Room on the right for the bubbles of a range that ends at the last column.
  const gutter = ranges.some((each) => each.sheet === sheet.name && each.range.right === lastColumn)
  const tabs = sheets.length > 1 && (
    <div className="tc-pane-tabs rd-sheet-tabs" role="tablist" aria-label="Sheets">
      {sheets.map((each) => {
        // A sheet with cells asked about says so on its tab, so they are found from another sheet.
        const asked = ranges.some((range) => range.sheet === each.name)
        return (
          <button key={each.name ?? ''} type="button" role="tab" aria-selected={each === sheet} onClick={() => setShownName(each.name)}
            aria-label={asked ? `${each.name}, with cells asked about` : undefined} title={asked ? 'Has cells you asked about' : undefined}>
            {each.name}{asked && <i className="rd-sheet-asked" aria-hidden="true" />}
          </button>
        )
      })}
    </div>
  )
  return (
    <div className="rd-sheet-view" style={gutter ? { paddingRight: GUTTER_PX } : undefined}>
      {tabs && (tabsInto ? createPortal(tabs, tabsInto) : tabs)}
      {sheet.noCells ? <p className="rd-empty">There are no cells on this sheet to show here. Open it in its own app to see it.</p>
        : !head ? <p className="rd-empty">This sheet is empty.</p> : (
          <div ref={grid} className={`rd-table-wrap rd-grid${askable ? ' askable' : ''}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => setDrawing(null)}>
            <table className="rd-table rd-cells" aria-label={sheet.name ?? undefined}>
              <thead>
                <tr>
                  <th className="rd-row-name" scope="col" aria-hidden="true" />
                  {columnNumbers.map((column) => (
                    <th key={column} scope="col" data-row={sheet.firstRow} data-column={column}>
                      {askable
                        ? <button type="button" className="rd-line-name" title="Mark the whole column" onClick={(event) => { if (event.detail === 0) wholeColumn(column) }}>{cellAt(sheet, sheet.firstRow, column)}</button>
                        : cellAt(sheet, sheet.firstRow, column)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.map((_, index) => {
                  const row = sheet.firstRow + index + 1
                  return (
                    <tr key={row}>
                      <th scope="row" className="rd-row-name" data-whole-row={askable ? row : undefined}>
                        {askable
                          ? <button type="button" className="rd-line-name" title="Mark the whole row" onClick={(event) => { if (event.detail === 0) wholeRow(row) }}>{row}</button>
                          : row}
                      </th>
                      {columnNumbers.map((column) => {
                        const cell = cellAt(sheet, row, column)
                        return <td key={column} data-row={row} data-column={column} className={isNumberCell(cell) ? 'num' : undefined}>{cell}</td>
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {placed.map((each) => (
              <div key={each.id || 'now'} className={each.className} data-range={JSON.stringify(each.range)} data-part={each.id || undefined} data-away={each.away ? '' : undefined} hidden={each.away}
                aria-hidden={each.id ? undefined : 'true'}>
                {each.id && !each.away && <span className={`rd-slot${dark ? ' on-dark' : ''}`} data-reader-chrome data-part={each.id} contentEditable={false} />}
              </div>
            ))}
          </div>
        )}
      {sheet.more && <p className="rd-note">The first {sheet.rows.length.toLocaleString('en-US')} rows are shown. Open it in its own app for the rest.</p>}
    </div>
  )
}
