/**
 * A CSV or TSV file read as a table for the reader (ADR 0077): quoted fields, doubled quotes and
 * line breaks inside quotes, as spreadsheets write them. Rows are kept as written — a short row
 * stays short — so nothing is shown that the file does not say.
 */
export interface Table {
  rows: string[][]
  /** The widest row's length. */
  columns: number
  /** More rows than were read. */
  more: boolean
}

/** The most rows the reader draws; a larger file shows its start. */
export const TABLE_MAX_ROWS = 2_000

export function parseTable(text: string, separator: ',' | '\t', maxRows = TABLE_MAX_ROWS): Table {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let at = 0
  const source = text.replace(/^﻿/, '')
  const endRow = () => {
    row.push(field)
    field = ''
    // A blank line between rows is not a row.
    if (row.length > 1 || row[0] !== '') rows.push(row)
    row = []
  }
  while (at < source.length && rows.length < maxRows) {
    const char = source[at]
    if (quoted) {
      if (char === '"' && source[at + 1] === '"') { field += '"'; at += 2; continue }
      if (char === '"') { quoted = false; at += 1; continue }
      field += char
      at += 1
      continue
    }
    if (char === '"' && field === '') { quoted = true; at += 1; continue }
    if (char === separator) { row.push(field); field = ''; at += 1; continue }
    if (char === '\r' && source[at + 1] === '\n') { endRow(); at += 2; continue }
    if (char === '\n' || char === '\r') { endRow(); at += 1; continue }
    field += char
    at += 1
  }
  const more = at < source.length && rows.length >= maxRows
  if (!more && (field !== '' || row.length > 0)) endRow()
  return { rows, columns: rows.reduce((widest, cells) => Math.max(widest, cells.length), 0), more }
}

/** The separator a file uses, by its extension, or by which of the two its first line has more of. */
export function separatorOf(path: string, text: string): ',' | '\t' {
  if (/\.tsv$/i.test(path)) return '\t'
  const end = text.indexOf('\n')
  const first = end < 0 ? text : text.slice(0, end)
  return (first.match(/\t/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? '\t' : ','
}

/** A cell that reads as a number, so the table can set it right-aligned like a spreadsheet. */
export function isNumberCell(cell: string): boolean {
  return /^[-+]?[$€£¥]?\s?\d[\d,.\s]*%?$/.test(cell.trim())
}
