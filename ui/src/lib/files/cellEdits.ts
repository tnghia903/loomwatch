import JSZip from 'jszip'

import { tableFields } from './table'

/**
 * A cell of a sheet changed by the person reading it (ADR 0107): the new value goes into that one
 * cell of the file, and nothing else in the file changes — in a CSV or TSV file, only that field's
 * characters; in an Excel workbook, only that cell of its sheet, and the note that tells Excel to
 * work its formulas out again when the workbook is opened.
 */

/** A field's words as the file writes them: in quotes when they hold what would end or change the field, or when the field was in quotes already. */
function fieldText(value: string, delimiter: ',' | '\t', quoted: boolean): string {
  const needs = quoted || value.includes(delimiter) || /["\r\n]/.test(value) || /^\s|\s$/.test(value)
  return needs ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * The CSV or TSV `text` with the cell at `row` and `col` (the sheet's own numbers, from 1, as
 * `parseTable` numbers them) saying `value`: only that field's characters change, quoted when they
 * need it, and every other byte stays as it was. A cell past the end of a short row is reached by
 * adding the fields between. `null` when the cell says that already, or there is no such row.
 */
export function withTableCell(text: string, row: number, col: number, value: string, delimiter: ',' | '\t'): string | null {
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 1 || col < 1) return null
  const { rows, spans } = tableFields(text, delimiter)
  const cells = rows[row - 1]
  const places = spans[row - 1]
  if (!cells || !places?.length) return null
  if ((cells[col - 1] ?? '') === value) return null
  if (col <= cells.length) {
    const place = places[col - 1]
    // A row of one field emptied keeps a field in quotes: a blank line would be no row at all.
    const written = fieldText(value, delimiter, place.quoted || (cells.length === 1 && value === ''))
    return text.slice(0, place.start) + written + text.slice(place.end)
  }
  const end = places[places.length - 1].end
  return text.slice(0, end) + delimiter.repeat(col - cells.length) + fieldText(value, delimiter, false) + text.slice(end)
}

/** A cell that can't be changed in the reader: the message says why, in words for the person. */
export class CellLocked extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CellLocked'
  }
}

const XML_NS = 'http://www.w3.org/XML/1998/namespace'
/** The most rows and columns an Excel sheet has. */
const MAX_ROWS = 1_048_576
const MAX_COLUMNS = 16_384

interface Xml { doc: Document; head: string }

async function readXml(zip: JSZip, path: string): Promise<Xml | null> {
  const file = zip.file(path)
  if (!file) return null
  const text = await file.async('string')
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) return null
  // The declaration and what follows it are put back as they were.
  return { doc, head: /^\uFEFF?<\?xml[^>]*\?>\s*/.exec(text)?.[0] ?? '' }
}

function writeXml(zip: JSZip, path: string, xml: Xml) {
  zip.file(path, xml.head + new XMLSerializer().serializeToString(xml.doc).replace(/^<\?xml[^>]*\?>\s*/, ''))
}

/** The child elements of `parent` in its own namespace named `name`. */
function children(parent: Element, name: string): Element[] {
  return Array.from(parent.children).filter((child) => child.localName === name && child.namespaceURI === parent.namespaceURI)
}

/** A new element in `near`'s namespace, with its prefix. */
function element(near: Element, name: string): Element {
  const doc = near.ownerDocument
  return doc.createElementNS(near.namespaceURI, near.prefix ? `${near.prefix}:${name}` : name)
}

interface Relationship { element: Element; type: string; path: string }
interface Rels { xml: Xml; path: string; list: Relationship[] }

/** A part's relationships, each with the path in the zip of the part it names. */
async function relsOf(zip: JSZip, part: string): Promise<Rels | null> {
  const folder = part.includes('/') ? part.slice(0, part.lastIndexOf('/')) : ''
  const path = `${folder ? `${folder}/` : ''}_rels/${part.slice(folder ? folder.length + 1 : 0)}.rels`
  const xml = await readXml(zip, path)
  if (!xml) return null
  const list = Array.from(xml.doc.documentElement.children).filter((each) => each.localName === 'Relationship' && each.getAttribute('TargetMode') !== 'External').map((each) => {
    const target = each.getAttribute('Target') ?? ''
    const parts = target.startsWith('/') ? [] : folder.split('/').filter(Boolean)
    for (const piece of target.split('/')) {
      if (piece === '..') parts.pop()
      else if (piece && piece !== '.') parts.push(piece)
    }
    return { element: each, type: each.getAttribute('Type') ?? '', path: decoded(parts.join('/')) }
  })
  return { xml, path, list }
}

function decoded(path: string): string {
  try { return decodeURIComponent(path) } catch { return path }
}

const isType = (relationship: Relationship, kind: string) => relationship.type.endsWith(`/${kind}`)

/** `B7` → row 7, column 2; `null` for anything else. */
function cellRef(ref: string | null): { row: number; column: number } | null {
  const match = ref ? /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(ref) : null
  if (!match) return null
  let column = 0
  for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64
  return { row: Number(match[2]), column }
}

function refName(row: number, column: number): string {
  let name = ''
  for (let rest = column; rest > 0; rest = Math.floor((rest - 1) / 26)) name = String.fromCharCode(65 + ((rest - 1) % 26)) + name
  return `${name}${row}`
}

/** `B2:D9` (or `B2`) as its corners. */
function areaOf(ref: string | null): { top: number; left: number; bottom: number; right: number } | null {
  const [first, last = first] = (ref ?? '').split(':')
  const a = cellRef(first)
  const b = cellRef(last)
  return a && b ? { top: Math.min(a.row, b.row), left: Math.min(a.column, b.column), bottom: Math.max(a.row, b.row), right: Math.max(a.column, b.column) } : null
}

/** The rows of a sheet's cells, each with its number: a row that doesn't say comes after the one before. */
function numbered(items: Element[], numberOf: (item: Element) => number | null): Array<{ item: Element; at: number }> {
  let last = 0
  return items.map((item) => {
    last = numberOf(item) ?? last + 1
    return { item, at: last }
  })
}

/** The words of a string item (`<si>` or `<is>`): its runs' words, not the pronunciation guides. */
function itemWords(item: Element): string {
  return Array.from(item.getElementsByTagNameNS(item.namespaceURI, 't'))
    .filter((t) => t.parentElement === item || (t.parentElement?.localName === 'r' && t.parentElement.parentElement === item))
    .map((t) => t.textContent ?? '').join('')
}

/** A cell as it reads now: its words, and its number or true-or-false when it is one. */
function cellNow(cell: Element | null, shared: () => Promise<string[]>): Promise<{ text: string; number: number | null; formula: Element | null }> {
  if (!cell) return Promise.resolve({ text: '', number: null, formula: null })
  const formula = children(cell, 'f')[0] ?? null
  const v = children(cell, 'v')[0]?.textContent ?? ''
  const type = cell.getAttribute('t') ?? 'n'
  if (type === 's') return shared().then((strings) => ({ text: strings[Number(v)] ?? '', number: null, formula }))
  if (type === 'inlineStr') {
    const item = children(cell, 'is')[0]
    return Promise.resolve({ text: item ? itemWords(item) : '', number: null, formula })
  }
  if (type === 'b') return Promise.resolve({ text: v === '1' ? 'TRUE' : 'FALSE', number: null, formula })
  return Promise.resolve({ text: v, number: type === 'n' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null, formula })
}

type Written = { kind: 'empty' } | { kind: 'number'; v: string } | { kind: 'bool'; v: '0' | '1' } | { kind: 'text'; text: string }

/** A number as a person types one: `12`, `-3.5`, `1e6`, `1,200`; not `007` (an id, kept as typed) nor more digits than Excel keeps. */
function numberOf(value: string): number | null {
  const bare = value.trim()
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(bare) && !/^[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(bare)) return null
  if (/^[-+]?0\d/.test(bare)) return null
  const digits = bare.replace(/[eE].*$/, '').replace(/\D/g, '').replace(/^0+/, '')
  if (digits.length > 15) return null
  const number = Number(bare.replace(/,/g, ''))
  return Number.isFinite(number) ? number : null
}

/** A date as the reader shows one (`2026-10-31`, `2026-10-31 09:30`), as Excel's number for it; `null` for anything else. */
function dateNumber(value: string, from1904: boolean): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim())
  if (!match) return null
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0))
  const moment = Date.UTC(year, month - 1, day, hour, minute, second)
  const back = new Date(moment)
  if (back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null
  const serial = (moment - (from1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30))) / 86_400_000
  // Before March 1900 Excel's count of days is a day out (it has a 29 February 1900).
  return serial >= (from1904 ? 0 : 61) ? serial : null
}

/** Excel's built-in number formats that show a date or a time. */
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58])

/** Whether a number format's code shows a date or a time: its days, months, years, hours or seconds, outside words in quotes. */
function isDateCode(code: string): boolean {
  const bare = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[(?![hms]+\])[^\]]*\]/gi, '').split(';')[0]
  return /[dmyhs]/i.test(bare)
}

/** Words in a string as Excel reads them back: its own escapes (`_x000D_`) kept as words, and characters XML can't hold escaped. */
function excelText(text: string): string {
  return text.replace(/_(x[0-9A-Fa-f]{4})_/g, '_x005F_$1_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, (char) => `_x${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`)
}

interface Book {
  path: string
  xml: Xml
  rels: Rels | null
}

async function bookOf(zip: JSZip): Promise<Book | null> {
  const root = await relsOf(zip, '')
  const path = root?.list.find((each) => isType(each, 'officeDocument'))?.path ?? 'xl/workbook.xml'
  const xml = await readXml(zip, path)
  return xml ? { path, xml, rels: await relsOf(zip, path) } : null
}

/** The part of a worksheet, by its name in the workbook, or the first for `null`. */
function sheetPath(book: Book, sheet: string | null): string | null {
  const root = book.xml.doc.documentElement
  const sheets = children(root, 'sheets')[0]
  const all = sheets ? children(sheets, 'sheet') : []
  const chosen = sheet === null ? all[0] : all.find((each) => each.getAttribute('name') === sheet)
  const id = chosen && Array.from(chosen.attributes).find((attribute) => attribute.localName === 'id' && attribute.namespaceURI)?.value
  const relationship = id ? book.rels?.list.find((each) => each.element.getAttribute('Id') === id) : undefined
  return relationship && isType(relationship, 'worksheet') ? relationship.path : null
}

/** Whether cell style `s` shows a date. */
async function dateStyled(zip: JSZip, book: Book, s: number | null): Promise<boolean> {
  if (s === null) return false
  const path = book.rels?.list.find((each) => isType(each, 'styles'))?.path
  const styles = path ? await readXml(zip, path) : null
  if (!styles) return false
  const root = styles.doc.documentElement
  const xfs = children(root, 'cellXfs')[0]
  const xf = xfs ? children(xfs, 'xf')[s] : undefined
  const id = Number(xf?.getAttribute('numFmtId') ?? 0)
  if (DATE_FORMATS.has(id)) return true
  const formats = children(root, 'numFmts')[0]
  const code = formats ? children(formats, 'numFmt').find((each) => Number(each.getAttribute('numFmtId')) === id)?.getAttribute('formatCode') : null
  return Boolean(code && isDateCode(code))
}

/**
 * The cell of a formula that other cells share or fill (`t="shared"` that other cells take it
 * from, or one cell of an array formula over several), which can only be changed in Excel:
 * changing it alone would break the workbook.
 */
function lockedBy(sheetData: Element, row: number, column: number): boolean {
  const formulas = Array.from(sheetData.getElementsByTagNameNS(sheetData.namespaceURI, 'f'))
  return formulas.some((formula) => {
    const area = areaOf(formula.getAttribute('ref'))
    if (!area || (area.top === area.bottom && area.left === area.right)) return false
    const kind = formula.getAttribute('t')
    if (kind === 'shared') {
      const own = cellRef(formula.parentElement?.getAttribute('r') ?? null)
      if (!own || own.row !== row || own.column !== column) return false
      const group = formula.getAttribute('si')
      return formulas.some((other) => other !== formula && other.getAttribute('t') === 'shared' && other.getAttribute('si') === group)
    }
    return row >= area.top && row <= area.bottom && column >= area.left && column <= area.right
  })
}

/** A sheet's `dimension` or a row's `spans` widened to take in a new column, when they name less. */
function widen(sheetRoot: Element, rowElement: Element, row: number, column: number) {
  const dimension = children(sheetRoot, 'dimension')[0]
  const area = areaOf(dimension?.getAttribute('ref') ?? null)
  if (dimension && area && (row < area.top || row > area.bottom || column < area.left || column > area.right)) {
    const next = { top: Math.min(area.top, row), left: Math.min(area.left, column), bottom: Math.max(area.bottom, row), right: Math.max(area.right, column) }
    dimension.setAttribute('ref', `${refName(next.top, next.left)}:${refName(next.bottom, next.right)}`)
  }
  const spans = /^(\d+):(\d+)$/.exec(rowElement.getAttribute('spans') ?? '')
  if (spans && (column < Number(spans[1]) || column > Number(spans[2]))) rowElement.setAttribute('spans', `${Math.min(Number(spans[1]), column)}:${Math.max(Number(spans[2]), column)}`)
}

/** The elements of the workbook that come after `calcPr`, in the order Excel requires. */
const AFTER_CALC = new Set(['oleSize', 'customWorkbookViews', 'pivotCaches', 'smartTagPr', 'smartTagTypes', 'webPublishing', 'fileRecoveryPr', 'webPublishObjects', 'extLst'])

/** Formulas are worked out again when the workbook is next opened: a cell they use has changed. */
function calculateOnOpen(book: Book) {
  const root = book.xml.doc.documentElement
  let calc = children(root, 'calcPr')[0]
  if (!calc) {
    calc = element(root, 'calcPr')
    root.insertBefore(calc, Array.from(root.children).find((child) => child.namespaceURI === root.namespaceURI && AFTER_CALC.has(child.localName)) ?? null)
  }
  calc.setAttribute('fullCalcOnLoad', '1')
}

/**
 * The calculation chain lists the cells that hold formulas; once a formula is gone from one, Excel
 * calls the workbook damaged unless the list goes too. Excel makes it again when it next saves.
 */
async function dropCalcChain(zip: JSZip, book: Book) {
  const chain = book.rels?.list.find((each) => isType(each, 'calcChain'))
  if (!book.rels || !chain || !zip.file(chain.path)) return
  zip.remove(chain.path)
  chain.element.remove()
  writeXml(zip, book.rels.path, book.rels.xml)
  const types = await readXml(zip, '[Content_Types].xml')
  const override = types && Array.from(types.doc.documentElement.children).find((each) => each.localName === 'Override' && each.getAttribute('PartName') === `/${chain.path}`)
  if (types && override) {
    override.remove()
    writeXml(zip, '[Content_Types].xml', types)
  }
}

/**
 * The workbook `bytes` (`.xlsx`, `.xlsm`) with the cell at `row` and `col` (the sheet's own numbers,
 * from 1) of sheet `sheet` (by name; the first sheet for `null`) saying `value`. A number is kept as
 * a number, `TRUE` or `FALSE` as true or false, a date typed into a cell that shows dates as that
 * date, and anything else as words; an empty value empties the cell. The cell keeps its style; a
 * formula in it gives way to the value, as the person's change wins. A missing row or cell is made
 * in its place. Formulas are worked out again when the workbook is next opened. Nothing else in the
 * workbook changes. `null` when the cell says that already, or there is no such sheet or cell;
 * `CellLocked` for a cell whose formula other cells share.
 */
export async function withWorkbookCell(bytes: ArrayBuffer | Uint8Array, sheet: string | null, row: number, col: number, value: string): Promise<Uint8Array | null> {
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 1 || col < 1 || row > MAX_ROWS || col > MAX_COLUMNS) return null
  const zip = await JSZip.loadAsync(bytes)
  const book = await bookOf(zip)
  const path = book && sheetPath(book, sheet)
  const xml = path ? await readXml(zip, path) : null
  const sheetRoot = xml?.doc.documentElement
  const sheetData = sheetRoot ? children(sheetRoot, 'sheetData')[0] : undefined
  if (!book || !path || !xml || !sheetRoot || !sheetData) return null

  const rows = numbered(children(sheetData, 'row'), (each) => Number(each.getAttribute('r')) || null)
  let rowElement = rows.find((each) => each.at === row)?.item ?? null
  const cells = rowElement ? numbered(children(rowElement, 'c'), (each) => cellRef(each.getAttribute('r'))?.column ?? null) : []
  let cell = cells.find((each) => each.at === col)?.item ?? null

  let strings: Promise<string[]> | null = null
  const shared = () => {
    strings ??= (async () => {
      const where = book.rels?.list.find((each) => isType(each, 'sharedStrings'))?.path
      const table = where ? await readXml(zip, where) : null
      return table ? children(table.doc.documentElement, 'si').map(itemWords) : []
    })()
    return strings
  }
  const now = await cellNow(cell, shared)
  const style = cell?.getAttribute('s') ?? null
  const workbookPr = children(book.xml.doc.documentElement, 'workbookPr')[0]
  const from1904 = /^(1|true)$/.test(workbookPr?.getAttribute('date1904') ?? '')
  const number = numberOf(value)
  const date = number === null ? dateNumber(value, from1904) : null
  const written: Written = value === '' ? { kind: 'empty' }
    : number !== null ? { kind: 'number', v: String(number) }
      : /^(true|false)$/i.test(value.trim()) ? { kind: 'bool', v: /^true$/i.test(value.trim()) ? '1' : '0' }
        : date !== null && await dateStyled(zip, book, style === null ? null : Number(style)) ? { kind: 'number', v: String(date) }
          : { kind: 'text', text: value }
  const same = now.text === value
    || (written.kind === 'number' && now.number !== null && now.number === Number(written.v))
    || (written.kind === 'bool' && cell?.getAttribute('t') === 'b' && now.text === (written.v === '1' ? 'TRUE' : 'FALSE'))
  if (same) return null
  if (lockedBy(sheetData, row, col)) throw new CellLocked('Other cells share this cell’s formula, so it can only be changed in the workbook’s own app.')

  if (!rowElement) {
    rowElement = element(sheetData, 'row')
    rowElement.setAttribute('r', String(row))
    sheetData.insertBefore(rowElement, rows.find((each) => each.at > row)?.item ?? null)
  }
  if (!cell) {
    cell = element(sheetData, 'c')
    rowElement.insertBefore(cell, cells.find((each) => each.at > col)?.item ?? null)
  }
  widen(sheetRoot, rowElement, row, col)

  // The cell keeps its place and its style; what it held, and how, goes.
  const hadFormula = Boolean(now.formula)
  cell.setAttribute('r', refName(row, col))
  for (const name of ['t', 'cm', 'vm', 'ph']) cell.removeAttribute(name)
  for (const child of Array.from(cell.children)) if (child.localName !== 'extLst') child.remove()
  const end = children(cell, 'extLst')[0] ?? null
  if (written.kind === 'number' || written.kind === 'bool') {
    if (written.kind === 'bool') cell.setAttribute('t', 'b')
    const v = element(sheetData, 'v')
    v.textContent = written.v
    cell.insertBefore(v, end)
  } else if (written.kind === 'text') {
    cell.setAttribute('t', 'inlineStr')
    const item = element(sheetData, 'is')
    const t = element(sheetData, 't')
    t.setAttributeNS(XML_NS, 'xml:space', 'preserve')
    t.textContent = excelText(written.text)
    item.appendChild(t)
    cell.insertBefore(item, end)
  }
  writeXml(zip, path, xml)
  calculateOnOpen(book)
  writeXml(zip, book.path, book.xml)
  if (hadFormula) await dropCalcChain(zip, book)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
