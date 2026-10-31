import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import { CellLocked, withTableCell, withWorkbookCell } from './cellEdits'
import { parseTable } from './table'

describe('a cell of a CSV or TSV file changed in the reader (ADR 0107)', () => {
  it('changes only that field’s characters, keeping every other byte, line endings and the last newline', () => {
    const text = '\uFEFFname,"note",sales\r\nAcme,"said ""hi""",12\r\n\r\nBeta,,7\r\n'
    // Row 3 is Beta's: a blank line is no row, as the reader numbers them.
    expect(withTableCell(text, 3, 3, '9', ',')).toBe('\uFEFFname,"note",sales\r\nAcme,"said ""hi""",12\r\n\r\nBeta,,9\r\n')
    expect(withTableCell(text, 3, 2, 'new', ',')).toBe('\uFEFFname,"note",sales\r\nAcme,"said ""hi""",12\r\n\r\nBeta,new,7\r\n')
    // A field in quotes stays in quotes.
    expect(withTableCell(text, 2, 2, 'quiet', ',')).toBe('\uFEFFname,"note",sales\r\nAcme,"quiet",12\r\n\r\nBeta,,7\r\n')
    expect(withTableCell('a,b\n1,2', 2, 2, '3', ',')).toBe('a,b\n1,3')
  })

  it('quotes a new value that holds the separator, a quote, a new line, or spaces at either end', () => {
    expect(withTableCell('a,b\n1,2\n', 2, 1, 'Acme, Inc.', ',')).toBe('a,b\n"Acme, Inc.",2\n')
    expect(withTableCell('a,b\n1,2\n', 2, 1, 'say "hi"', ',')).toBe('a,b\n"say ""hi""",2\n')
    expect(withTableCell('a,b\n1,2\n', 2, 1, 'two\nlines', ',')).toBe('a,b\n"two\nlines",2\n')
    expect(withTableCell('a,b\n1,2\n', 2, 1, ' padded', ',')).toBe('a,b\n" padded",2\n')
    expect(withTableCell('a\tb\n1\t2\n', 2, 2, 'x\ty', '\t')).toBe('a\tb\n1\t"x\ty"\n')
    // A comma is only words in a TSV file.
    expect(withTableCell('a\tb\n1\t2\n', 2, 2, '1,5', '\t')).toBe('a\tb\n1\t1,5\n')
    // Each comes back as typed.
    for (const value of ['Acme, Inc.', 'say "hi"', 'two\nlines', ' padded ']) {
      expect(parseTable(withTableCell('a,b\n1,2\n', 2, 1, value, ',')!, ',').rows[1]).toEqual([value, '2'])
    }
  })

  it('reaches a cell past the end of a short row, and keeps a row of one emptied field a row', () => {
    expect(withTableCell('a,b,c\nd\ne,f,g\n', 2, 3, 'z', ',')).toBe('a,b,c\nd,,z\ne,f,g\n')
    const one = withTableCell('name\nAda\nBo\n', 2, 1, '', ',')
    expect(one).toBe('name\n""\nBo\n')
    // Bo is still the third row.
    expect(parseTable(one!, ',').rows).toEqual([['name'], [''], ['Bo']])
  })

  it('changes nothing when the cell says that already, or there is no such cell', () => {
    expect(withTableCell('a,b\n1,2\n', 2, 2, '2', ',')).toBeNull()
    expect(withTableCell('a,b\n1,2\n', 2, 5, '', ',')).toBeNull()
    expect(withTableCell('a,b\n1,2\n', 3, 1, 'x', ',')).toBeNull()
    expect(withTableCell('a,b\n1,2\n', 0, 1, 'x', ',')).toBeNull()
  })
})

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

const worksheet = (rows: string, extra = '') => `${DECLARATION}<worksheet xmlns="${MAIN}" xmlns:r="${DOC_REL}"><dimension ref="B2:C4"/>${extra}<sheetData>${rows}</sheetData></worksheet>`

interface BookParts { calcPr?: string; sheet2?: string; date1904?: boolean }

/**
 * A workbook of two sheets, "Sales & costs" (its used cells from B2, as an agent's often start) and
 * "Notes"; a shared word, a dated cell, a total worked out by a formula, and a calculation chain.
 */
async function book({ calcPr = '<calcPr calcId="191029"/>', sheet2, date1904 = false }: BookParts = {}): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `${DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>`)
  zip.file('_rels/.rels', `${DECLARATION}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${DOC_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
  zip.file('xl/workbook.xml', `${DECLARATION}<workbook xmlns="${MAIN}" xmlns:r="${DOC_REL}"><workbookPr${date1904 ? ' date1904="1"' : ''}/><sheets><sheet name="Sales &amp; costs" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets>${calcPr}<extLst/></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `${DECLARATION}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${DOC_REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${DOC_REL}/worksheet" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${DOC_REL}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId4" Type="${DOC_REL}/styles" Target="styles.xml"/><Relationship Id="rId5" Type="${DOC_REL}/calcChain" Target="calcChain.xml"/></Relationships>`)
  zip.file('xl/sharedStrings.xml', `${DECLARATION}<sst xmlns="${MAIN}" count="3" uniqueCount="3"><si><t>Region</t></si><si><t>West</t></si><si><r><t>Ea</t></r><r><t>st</t></r></si></sst>`)
  zip.file('xl/styles.xml', `${DECLARATION}<styleSheet xmlns="${MAIN}"><numFmts count="1"><numFmt numFmtId="164" formatCode="d\\ mmm\\ yyyy"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="3"/><xf numFmtId="164"/></cellXfs></styleSheet>`)
  zip.file('xl/calcChain.xml', `${DECLARATION}<calcChain xmlns="${MAIN}"><c r="C4" i="1"/></calcChain>`)
  zip.file('xl/worksheets/sheet1.xml', worksheet(
    '<row r="2" spans="2:3"><c r="B2" t="s"><v>0</v></c><c r="C2" s="2"><v>46326</v></c></row>'
    + '<row r="3" spans="2:3"><c r="B3" t="s"><v>1</v></c><c r="C3" s="1"><v>260</v></c></row>'
    + '<row r="4" spans="2:3"><c r="B4" t="s"><v>2</v></c><c r="C4" s="1"><f>SUM(C3:C3)</f><v>260</v></c></row>',
  ))
  zip.file('xl/worksheets/sheet2.xml', sheet2 ?? worksheet('<row r="1"><c r="A1" t="inlineStr"><is><t>Hello</t></is></c></row>'))
  zip.file('xl/vbaProject.bin', new Uint8Array([1, 2, 3, 4]))
  return zip.generateAsync({ type: 'uint8array' })
}

const opened = async (bytes: Uint8Array | null) => JSZip.loadAsync(bytes!)
const part = async (bytes: Uint8Array | null, path: string) => (await opened(bytes)).file(path)!.async('string')
const sheetOf = async (bytes: Uint8Array | null, path = 'xl/worksheets/sheet1.xml') => new DOMParser().parseFromString(await part(bytes, path), 'application/xml')
const cellOf = (doc: Document, ref: string) => Array.from(doc.getElementsByTagNameNS(MAIN, 'c')).find((cell) => cell.getAttribute('r') === ref) ?? null

describe('a cell of an Excel workbook changed in the reader (ADR 0107)', () => {
  it('writes a number as a number and words as words, keeping the cell’s style, on the sheet named', async () => {
    const before = await book()
    const number = await withWorkbookCell(before, 'Sales & costs', 3, 3, '275')
    const doc = await sheetOf(number)
    expect(cellOf(doc, 'C3')!.getAttribute('s')).toBe('1')
    expect(cellOf(doc, 'C3')!.getAttribute('t')).toBeNull()
    expect(cellOf(doc, 'C3')!.textContent).toBe('275')
    const words = await sheetOf(await withWorkbookCell(before, 'Sales & costs', 3, 2, 'West & north <coast>'))
    const west = cellOf(words, 'B3')!
    expect(west.getAttribute('t')).toBe('inlineStr')
    const t = west.getElementsByTagNameNS(MAIN, 't')[0]
    expect(t.textContent).toBe('West & north <coast>')
    expect(t.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'space')).toBe('preserve')
    expect(west.getElementsByTagNameNS(MAIN, 'v')).toHaveLength(0)
    // The other sheet is the other part.
    const notes = await sheetOf(await withWorkbookCell(before, 'Notes', 1, 1, 'Bye'), 'xl/worksheets/sheet2.xml')
    expect(cellOf(notes, 'A1')!.textContent).toBe('Bye')
  })

  it('keeps the XML declaration, and touches no other part but the workbook’s note to work formulas out again', async () => {
    const before = await book()
    const after = await withWorkbookCell(before, 'Sales & costs', 3, 3, '275')
    expect(await part(after, 'xl/worksheets/sheet1.xml')).toMatch(/^<\?xml version="1\.0" encoding="UTF-8" standalone="yes"\?>\r\n<worksheet /)
    const was = await opened(before)
    const now = await opened(after)
    expect(Object.keys(now.files).sort()).toEqual(Object.keys(was.files).sort())
    for (const [path, file] of Object.entries(was.files)) {
      if (file.dir || path === 'xl/worksheets/sheet1.xml' || path === 'xl/workbook.xml') continue
      expect(await now.file(path)!.async('uint8array'), path).toEqual(await was.file(path)!.async('uint8array'))
    }
    const workbook = await part(after, 'xl/workbook.xml')
    expect(workbook).toMatch(/^<\?xml version="1\.0" encoding="UTF-8" standalone="yes"\?>\r\n<workbook /)
    expect(workbook).toContain('<calcPr calcId="191029" fullCalcOnLoad="1"/>')
  })

  it('adds the note to work formulas out again where Excel looks for it, when the workbook has none', async () => {
    const workbook = await part(await withWorkbookCell(await book({ calcPr: '' }), null, 3, 3, '1'), 'xl/workbook.xml')
    expect(workbook).toContain('</sheets><calcPr fullCalcOnLoad="1"/><extLst/>')
  })

  it('replaces a formula with the value typed, and lets go of the calculation chain that lists it', async () => {
    const after = await withWorkbookCell(await book(), 'Sales & costs', 4, 3, '300')
    const total = cellOf(await sheetOf(after), 'C4')!
    expect(total.getElementsByTagNameNS(MAIN, 'f')).toHaveLength(0)
    expect(total.textContent).toBe('300')
    expect(total.getAttribute('s')).toBe('1')
    const zip = await opened(after)
    expect(zip.file('xl/calcChain.xml')).toBeNull()
    expect(await part(after, 'xl/_rels/workbook.xml.rels')).not.toContain('calcChain')
    expect(await part(after, '[Content_Types].xml')).not.toContain('calcChain')
    expect(await part(after, '[Content_Types].xml')).toContain('/xl/workbook.xml')
    // A cell with no formula leaves the chain alone.
    expect((await opened(await withWorkbookCell(await book(), 'Sales & costs', 3, 3, '1'))).file('xl/calcChain.xml')).not.toBeNull()
  })

  it('makes a missing row and cell in their places, and widens the sheet’s size and the row’s columns', async () => {
    const after = await withWorkbookCell(await book(), 'Sales & costs', 3, 5, 'later')
    const doc = await sheetOf(after)
    const row3 = Array.from(doc.getElementsByTagNameNS(MAIN, 'row')).find((row) => row.getAttribute('r') === '3')!
    expect(Array.from(row3.children).map((cell) => cell.getAttribute('r'))).toEqual(['B3', 'C3', 'E3'])
    expect(row3.getAttribute('spans')).toBe('2:5')
    expect(doc.getElementsByTagNameNS(MAIN, 'dimension')[0].getAttribute('ref')).toBe('B2:E4')
    const between = await sheetOf(await withWorkbookCell(await book(), 'Sales & costs', 3, 1, 'first'))
    expect(Array.from(between.getElementsByTagNameNS(MAIN, 'row'))[1].firstElementChild!.getAttribute('r')).toBe('A3')
    const above = await sheetOf(await withWorkbookCell(await book(), 'Sales & costs', 1, 2, 'Title'))
    expect(Array.from(above.getElementsByTagNameNS(MAIN, 'row')).map((row) => row.getAttribute('r'))).toEqual(['1', '2', '3', '4'])
    expect(above.getElementsByTagNameNS(MAIN, 'dimension')[0].getAttribute('ref')).toBe('B1:C4')
    const below = await sheetOf(await withWorkbookCell(await book(), 'Sales & costs', 9, 3, '5'))
    expect(Array.from(below.getElementsByTagNameNS(MAIN, 'row')).map((row) => row.getAttribute('r'))).toEqual(['2', '3', '4', '9'])
  })

  it('finds rows and cells that don’t say their place by the ones before them', async () => {
    const sheet2 = worksheet('<row><c><v>1</v></c><c><v>2</v></c></row><row><c><v>3</v></c></row>')
    const doc = await sheetOf(await withWorkbookCell(await book({ sheet2 }), 'Notes', 1, 2, '20'), 'xl/worksheets/sheet2.xml')
    const [first] = Array.from(doc.getElementsByTagNameNS(MAIN, 'row'))
    expect(Array.from(first.children).map((cell) => cell.textContent)).toEqual(['1', '20'])
    expect(first.children[1].getAttribute('r')).toBe('B1')
  })

  it('writes a date typed into a cell that shows dates as that date, and TRUE as true', async () => {
    // 46326 is 31 October 2026; the cell's style shows it as a date.
    const date = cellOf(await sheetOf(await withWorkbookCell(await book(), 'Sales & costs', 2, 3, '2026-11-02 12:00')), 'C2')!
    expect(date.textContent).toBe('46328.5')
    expect(date.getAttribute('t')).toBeNull()
    expect(date.getAttribute('s')).toBe('2')
    const in1904 = cellOf(await sheetOf(await withWorkbookCell(await book({ date1904: true }), 'Sales & costs', 2, 3, '1904-01-03')), 'C2')!
    expect(in1904.textContent).toBe('2')
    // In a cell that shows numbers, a date is words.
    expect(cellOf(await sheetOf(await withWorkbookCell(await book(), 'Sales & costs', 3, 3, '2026-11-02')), 'C3')!.getAttribute('t')).toBe('inlineStr')
    const yes = cellOf(await sheetOf(await withWorkbookCell(await book(), 'Sales & costs', 3, 3, 'true')), 'C3')!
    expect(yes.getAttribute('t')).toBe('b')
    expect(yes.textContent).toBe('1')
    // An id with a leading zero, and a number longer than Excel keeps, stay as typed.
    for (const id of ['007', '12345678901234567']) {
      const cell = cellOf(await sheetOf(await withWorkbookCell(await book(), 'Sales & costs', 3, 3, id)), 'C3')!
      expect(cell.getAttribute('t')).toBe('inlineStr')
      expect(cell.textContent).toBe(id)
    }
  })

  it('empties a cell to its style alone', async () => {
    const cell = cellOf(await sheetOf(await withWorkbookCell(await book(), 'Sales & costs', 3, 2, '')), 'B3')!
    expect(cell.getAttribute('t')).toBeNull()
    expect(cell.childElementCount).toBe(0)
  })

  it('keeps Excel’s own escapes in words as words', async () => {
    const cell = cellOf(await sheetOf(await withWorkbookCell(await book(), 'Notes', 1, 1, 'a_x000D_b\u0001'), 'xl/worksheets/sheet2.xml'), 'A1')!
    expect(cell.textContent).toBe('a_x005F_x000D_b_x0001_')
  })

  it('changes nothing when the cell says that already, or there is no such sheet or cell', async () => {
    const before = await book()
    expect(await withWorkbookCell(before, 'Sales & costs', 3, 2, 'West')).toBeNull()
    expect(await withWorkbookCell(before, 'Sales & costs', 4, 2, 'East')).toBeNull()
    expect(await withWorkbookCell(before, 'Sales & costs', 3, 3, '260.0')).toBeNull()
    expect(await withWorkbookCell(before, 'Sales & costs', 2, 3, '2026-10-31')).toBeNull()
    expect(await withWorkbookCell(before, 'Sales & costs', 9, 9, '')).toBeNull()
    expect(await withWorkbookCell(before, 'Missing', 1, 1, 'x')).toBeNull()
    expect(await withWorkbookCell(before, null, 0, 1, 'x')).toBeNull()
  })

  it('refuses a cell whose formula other cells share or fill, which only Excel can change', async () => {
    const sheet2 = worksheet(
      '<row r="1"><c r="A1"><f t="shared" ref="A1:A2" si="0">B1*2</f><v>2</v></c><c r="B1"><v>1</v></c></row>'
      + '<row r="2"><c r="A2"><f t="shared" si="0"/><v>4</v></c><c r="B2"><v>2</v></c></row>'
      + '<row r="3"><c r="A3"><f t="array" ref="A3:B3">B1:B2*3</f><v>3</v></c><c r="B3"><v>6</v></c></row>',
    )
    const bytes = await book({ sheet2 })
    await expect(withWorkbookCell(bytes, 'Notes', 1, 1, '5')).rejects.toBeInstanceOf(CellLocked)
    await expect(withWorkbookCell(bytes, 'Notes', 3, 2, '5')).rejects.toBeInstanceOf(CellLocked)
    // A cell that takes the shared formula can be changed: the formula's own cell still says it.
    const after = await sheetOf(await withWorkbookCell(bytes, 'Notes', 2, 1, '9'), 'xl/worksheets/sheet2.xml')
    expect(cellOf(after, 'A2')!.textContent).toBe('9')
    expect(cellOf(after, 'A1')!.getElementsByTagNameNS(MAIN, 'f')[0].textContent).toBe('B1*2')
  })
})
