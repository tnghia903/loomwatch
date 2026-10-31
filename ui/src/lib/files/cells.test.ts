import { describe, expect, it } from 'vitest'

import { cellAt, cellsCopied, cellsLine, cellsText, columnName, inRange, parseWorkbook, rangeBetween, rangeName, SHEET_MAX_ROWS, sheetColumns, tableSheet, type Sheet } from './cells'

const sales: Sheet = {
  name: null,
  rows: [['Region', 'Q1', 'Q2'], ['West', '120', '140'], ['East', '80', ''], ['North', '60', '75']],
  firstRow: 1,
  firstColumn: 1,
  more: false,
}

describe('cells of a sheet (ADR 0091)', () => {
  it('are named as a spreadsheet names them', () => {
    expect([1, 2, 26, 27, 28, 52, 53, 702, 703].map(columnName)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA'])
    expect(rangeName({ top: 3, left: 2, bottom: 3, right: 2 })).toBe('B3')
    expect(rangeName({ top: 3, left: 2, bottom: 9, right: 4 })).toBe('B3:D9')
  })

  it('are the range between two cells, either way round', () => {
    const range = rangeBetween({ row: 9, column: 4 }, { row: 3, column: 2 })
    expect(range).toEqual({ top: 3, left: 2, bottom: 9, right: 4 })
    expect(inRange(range, 3, 2)).toBe(true)
    expect(inRange(range, 9, 4)).toBe(true)
    expect(inRange(range, 10, 4)).toBe(false)
    expect(inRange(range, 5, 1)).toBe(false)
  })

  it('are read where the sheet starts, which may be below and right of A1', () => {
    const offset: Sheet = { ...sales, firstRow: 3, firstColumn: 2 }
    expect(cellAt(offset, 3, 2)).toBe('Region')
    expect(cellAt(offset, 4, 3)).toBe('120')
    expect(cellAt(offset, 1, 1)).toBe('')
    expect(sheetColumns(offset)).toBe(3)
  })

  it('are asked about as their words, under the column names and after the row names when they are outside them', () => {
    expect(cellsText(sales, { top: 2, left: 2, bottom: 3, right: 3 })).toBe('Region\tQ1\tQ2\nWest\t120\t140\nEast\t80')
    expect(cellsText(sales, { top: 2, left: 3, bottom: 4, right: 3 })).toBe('Region\tQ2\nWest\t140\nEast\nNorth\t75')
    expect(cellsText(sales, { top: 1, left: 1, bottom: 2, right: 2 })).toBe('Region\tQ1\nWest\t120')
    expect(cellsText(sales, { top: 3, left: 1, bottom: 3, right: 1 })).toBe('Region\nEast')
    // Empty cells alone are named by their rows, which the sheet shows.
    expect(cellsText(sales, { top: 6, left: 5, bottom: 7, right: 6 })).toBe('Empty cells in rows 6 to 7')
    expect(cellsText(sales, { top: 6, left: 5, bottom: 6, right: 6 })).toBe('Empty cells in row 6')
    expect(cellsText(sales, { top: 3, left: 3, bottom: 3, right: 3 })).toBe('An empty cell in row 3')
  })

  it('are copied alone, by row and tab, and quoted on one line with their sheet first', () => {
    expect(cellsCopied(sales, { top: 2, left: 2, bottom: 3, right: 3 })).toBe('120\t140\n80\t')
    expect(cellsLine('Region\tQ1\tQ2\nWest\t120\t140\nEast\t80', 'By region')).toBe('By region · Region, Q1, Q2 · West, 120, 140 · East, 80')
    expect(cellsLine('Q1\n120')).toBe('Q1 · 120')
  })

  it('are read out of a workbook as the agents read it: each sheet by name, from its first cell', () => {
    const text = [
      'Sheet 1 of 3: Q3 (sales) (3 rows, 2 columns)',
      'Region\tSales',
      '',
      'East\t80',
      '',
      'Sheet 2 of 3: Notes (empty)',
      '',
      'Sheet 3 of 3: Offset (2 rows, 2 columns, from cell AB12)',
      'x\ty',
      '1\t2',
      '',
    ].join('\n')
    const sheets = parseWorkbook(text)
    expect(sheets.map((sheet) => [sheet.name, sheet.firstRow, sheet.firstColumn, sheet.rows])).toEqual([
      ['Q3 (sales)', 1, 1, [['Region', 'Sales'], [], ['East', '80']]],
      ['Notes', 1, 1, []],
      ['Offset', 12, 28, [['x', 'y'], ['1', '2']]],
    ])
    expect(sheets.every((sheet) => !sheet.more)).toBe(true)
    // A data row that only looks like a sheet's first line stays a row.
    expect(parseWorkbook('Sheet 1 of 1: A (2 rows, 1 column)\nSheet 5 of 9: B (empty)\nx\n')[0].rows).toEqual([['Sheet 5 of 9: B (empty)'], ['x']])
  })

  it('reads a CSV or TSV file as the one sheet it is', () => {
    expect(tableSheet('a,b\n1,"2,5"\n', '/w/x.csv')).toEqual({ name: null, rows: [['a', 'b'], ['1', '2,5']], firstRow: 1, firstColumn: 1, more: false })
    expect(tableSheet('a\tb\n1\t2\n', '/w/x.tsv').rows).toEqual([['a', 'b'], ['1', '2']])
    expect(tableSheet(Array.from({ length: SHEET_MAX_ROWS + 5 }, (_, index) => String(index)).join('\n'), '/w/x.csv').more).toBe(true)
  })

  it('shows a big sheet’s start, and says when the workbook’s words were cut', () => {
    const big = ['Sheet 1 of 1: Big (3000 rows, 1 column)', ...Array.from({ length: 3_000 }, (_, index) => String(index))].join('\n')
    const [sheet] = parseWorkbook(big)
    expect(sheet.rows).toHaveLength(SHEET_MAX_ROWS)
    expect(sheet.more).toBe(true)
  })

  it('knows a sheet that holds no cells, a chart say, from an empty one', () => {
    const [chart, empty] = parseWorkbook('Sheet 1 of 2: Chart (not a table of cells)\n\nSheet 2 of 2: Blank (empty)\n')
    expect(chart).toMatchObject({ name: 'Chart', noCells: true, rows: [] })
    expect(empty.noCells).toBeUndefined()
  })

  it('cut a long range at a row, saying so', () => {
    const long: Sheet = { ...sales, rows: [['Name'], ...Array.from({ length: 3_000 }, (_, index) => [`Person number ${index}`])] }
    const text = cellsText(long, { top: 2, left: 1, bottom: 3_001, right: 1 })
    expect(text.length).toBeLessThanOrEqual(4_002)
    expect(text.endsWith('\n…')).toBe(true)
    expect(text.startsWith('Name\nPerson number 0\n')).toBe(true)
  })
})
