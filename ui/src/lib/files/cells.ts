import { parseTable, separatorOf } from './table'

/**
 * Cells of a sheet asked about (ADR 0091): a range marked by dragging across a sheet in the reader,
 * kept by where it is (`chat::PartAt::Cells`) and asked about as the cells' own words — a small
 * table with its column names — so the agent reads what was marked and knows where it is.
 */

/** A range of cells, by the sheet's own row and column numbers, from 1, corners included. */
export interface CellRange { top: number; left: number; bottom: number; right: number }

/** One sheet as the reader draws it: its cells by row, and where its first cell is in the sheet. */
export interface Sheet {
  /** Its name in the workbook; `null` for a CSV or TSV file, which has one. */
  name: string | null
  rows: string[][]
  /** The sheet's row and column numbers of `rows[0][0]`, from 1 (a sheet may start at B3). */
  firstRow: number
  firstColumn: number
  /** More rows than were read. */
  more: boolean
  /** A sheet of a workbook that holds no cells to show: a chart, say. */
  noCells?: boolean
}

/** The most of a range's words asked about, as `passage.ts` keeps for words. */
const CELLS_MAX_CHARS = 4_000
/** The most rows of one sheet the reader draws; a larger sheet shows its start. */
export const SHEET_MAX_ROWS = 2_000

/**
 * A sheet's first line in the words the daemon reads out of a workbook (`documents/excel.rs`):
 * "Sheet 2 of 3: Sales (12 rows, 4 columns, from cell B3)", "… (empty)" or "… (not a table of cells)".
 */
const SHEET_LINE = /^Sheet (\d+) of (\d+): (.*) \((?:(\d+) rows?, (\d+) columns?(?:, from cell ([A-Z]+)(\d+))?|empty|not a table of cells)\)$/

/** A CSV or TSV file as the one sheet it is. */
export function tableSheet(text: string, path: string): Sheet {
  const table = parseTable(text, separatorOf(path, text), SHEET_MAX_ROWS)
  return { name: null, rows: table.rows, firstRow: 1, firstColumn: 1, more: table.more }
}

/** `A` → 1, `AB` → 28. */
function columnNumber(name: string): number {
  let number = 0
  for (const letter of name) number = number * 26 + letter.charCodeAt(0) - 64
  return number
}

/**
 * The sheets of a workbook from the words the daemon reads out of it, as the agents read them: each
 * sheet's first line names it and says where its first cell is, and each row after it is its cells
 * by tab. Rows past `SHEET_MAX_ROWS` are left for the workbook's own app; the empty lines between
 * sheets are not rows. A workbook whose words were cut says so once, where it is shown.
 */
export function parseWorkbook(text: string): Sheet[] {
  const sheets: Sheet[] = []
  let current: Sheet | null = null
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const header = SHEET_LINE.exec(line)
    if (header && Number(header[1]) === sheets.length + 1) {
      current = { name: header[3], rows: [], firstRow: header[7] ? Number(header[7]) : 1, firstColumn: header[6] ? columnNumber(header[6]) : 1, more: false, ...(line.endsWith('(not a table of cells)') ? { noCells: true } : {}) }
      sheets.push(current)
      continue
    }
    if (!current) continue
    if (current.rows.length >= SHEET_MAX_ROWS) { current.more = current.more || line !== ''; continue }
    current.rows.push(line === '' ? [] : line.split('\t'))
  }
  for (const sheet of sheets) while (sheet.rows.length && sheet.rows[sheet.rows.length - 1].length === 0) sheet.rows.pop()
  return sheets
}

/** `1` → `A`, `28` → `AB`: a column as a spreadsheet names it. */
export function columnName(column: number): string {
  let name = ''
  for (let rest = Math.max(1, Math.floor(column)); rest > 0; rest = Math.floor((rest - 1) / 26)) name = String.fromCharCode(65 + ((rest - 1) % 26)) + name
  return name
}

/** `B3`, or `B3:D9` for more than one cell. */
export function rangeName(range: CellRange): string {
  const first = `${columnName(range.left)}${range.top}`
  return range.top === range.bottom && range.left === range.right ? first : `${first}:${columnName(range.right)}${range.bottom}`
}

/** The range between two cells, either way round. */
export function rangeBetween(a: { row: number; column: number }, b: { row: number; column: number }): CellRange {
  return { top: Math.min(a.row, b.row), left: Math.min(a.column, b.column), bottom: Math.max(a.row, b.row), right: Math.max(a.column, b.column) }
}

/** Whether a cell is in a range. */
export function inRange(range: CellRange, row: number, column: number): boolean {
  return row >= range.top && row <= range.bottom && column >= range.left && column <= range.right
}

/** A sheet's cell by its row and column numbers; `''` outside what the sheet holds. */
export function cellAt(sheet: Sheet, row: number, column: number): string {
  return sheet.rows[row - sheet.firstRow]?.[column - sheet.firstColumn] ?? ''
}

/** How many columns the sheet's widest row has. */
export function sheetColumns(sheet: Sheet): number {
  return sheet.rows.reduce((widest, cells) => Math.max(widest, cells.length), 0)
}

/** A cell's words on one line. */
const flat = (cell: string) => cell.replace(/[\t\r\n]+/g, ' ').trim()

/**
 * The words a range is asked about: its cells by row, separated by tabs, under the sheet's first
 * row (its column names) when the range starts below it, and after the first column's cell (its
 * row's name) when the range starts right of it — so a number is read with what it counts and
 * whose it is. Cut at a row past what a part keeps. Empty cells alone are named by their rows.
 */
export function cellsText(sheet: Sheet, range: CellRange): string {
  const named = range.left > sheet.firstColumn
  const line = (row: number) => {
    const cells: string[] = named ? [flat(cellAt(sheet, row, sheet.firstColumn))] : []
    for (let column = range.left; column <= range.right; column++) cells.push(flat(cellAt(sheet, row, column)))
    return cells.join('\t').replace(/\t+$/, '')
  }
  const lines: string[] = []
  if (range.top > sheet.firstRow && line(sheet.firstRow).trim()) lines.push(line(sheet.firstRow))
  let length = lines.join('\n').length
  let any = false
  for (let row = range.top; row <= range.bottom; row++) {
    const next = line(row)
    if (length + next.length + 1 > CELLS_MAX_CHARS) { lines.push('…'); break }
    lines.push(next)
    length += next.length + 1
    for (let column = range.left; column <= range.right && !any; column++) any = flat(cellAt(sheet, row, column)) !== ''
  }
  if (!any) {
    const rows = range.top === range.bottom ? `row ${range.top}` : `rows ${range.top} to ${range.bottom}`
    return range.top === range.bottom && range.left === range.right ? `An empty cell in ${rows}` : `Empty cells in ${rows}`
  }
  return lines.join('\n').replace(/^\n+|\n+$/g, '')
}

/** The marked cells alone, by row and tab, as a spreadsheet copies them. */
export function cellsCopied(sheet: Sheet, range: CellRange): string {
  const rows: string[] = []
  for (let row = range.top; row <= range.bottom; row++) {
    const cells: string[] = []
    for (let column = range.left; column <= range.right; column++) cells.push(flat(cellAt(sheet, row, column)))
    rows.push(cells.join('\t'))
  }
  return rows.join('\n')
}

/**
 * A range's words on one line, as a quote of it reads in the chat: its sheet's name first in a
 * workbook, its cells by commas and its rows by dots — "By region · Q1, Q2 · 120, 140 · 80, 95".
 */
export function cellsLine(text: string, sheet?: string | null): string {
  const rows = text.split('\n').map((row) => row.split('\t').map((cell) => cell.trim()).filter(Boolean).join(', ')).filter(Boolean)
  return [...(sheet ? [sheet] : []), ...rows].join(' · ')
}
