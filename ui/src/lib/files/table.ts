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
  return scan(text, separator, maxRows)
}

/** Where a field is written in the file's text: its first character to the one after its last, its quotes included. */
export interface FieldSpan {
  start: number
  end: number
  /** It is written in quotes. */
  quoted: boolean
}

/**
 * Every row of a CSV or TSV file as `parseTable` reads it, with where each of its fields is written
 * in the text, so one field can be changed and nothing else (`cellEdits.ts`).
 */
export function tableFields(text: string, separator: ',' | '\t'): { rows: string[][]; spans: FieldSpan[][] } {
  const spans: FieldSpan[][] = []
  return { rows: scan(text, separator, Infinity, spans).rows, spans }
}

function scan(text: string, separator: ',' | '\t', maxRows: number, spans?: FieldSpan[][]): Table {
  const rows: string[][] = []
  let row: string[] = []
  let rowSpans: FieldSpan[] = []
  let field = ''
  let quoted = false
  // The field opened with a quote, and where it starts in `source`.
  let opened = false
  let from = 0
  let at = 0
  const skipped = text.startsWith('\uFEFF') ? 1 : 0
  const source = skipped ? text.slice(skipped) : text
  const endField = (end: number) => {
    row.push(field)
    if (spans) rowSpans.push({ start: from + skipped, end: end + skipped, quoted: opened })
    field = ''
    opened = false
  }
  const endRow = (end: number) => {
    const any = opened
    endField(end)
    // A blank line between rows is not a row; a line of one empty field in quotes is.
    if (row.length > 1 || row[0] !== '' || any) {
      rows.push(row)
      spans?.push(rowSpans)
    }
    row = []
    rowSpans = []
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
    if (char === '"' && field === '') { quoted = true; opened = true; at += 1; continue }
    if (char === separator) { endField(at); at += 1; from = at; continue }
    if (char === '\r' && source[at + 1] === '\n') { endRow(at); at += 2; from = at; continue }
    if (char === '\n' || char === '\r') { endRow(at); at += 1; from = at; continue }
    field += char
    at += 1
  }
  const more = at < source.length && rows.length >= maxRows
  if (!more && (field !== '' || row.length > 0 || opened)) endRow(at)
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
