import { describe, expect, it } from 'vitest'

import { isNumberCell, parseTable, separatorOf } from './table'

describe('a CSV or TSV file read as a table', () => {
  it('reads quoted fields, doubled quotes and line breaks inside quotes', () => {
    const table = parseTable('﻿name,note,sales\r\n"Acme, Inc.","said ""hi""\nthen left",12\n\nBeta,,7', ',')
    expect(table.rows).toEqual([
      ['name', 'note', 'sales'],
      ['Acme, Inc.', 'said "hi"\nthen left', '12'],
      ['Beta', '', '7'],
    ])
    expect(table.columns).toBe(3)
    expect(table.more).toBe(false)
  })

  it('keeps a short row short and stops at the most rows it draws', () => {
    expect(parseTable('a,b,c\nd', ',').rows).toEqual([['a', 'b', 'c'], ['d']])
    const big = parseTable(Array.from({ length: 10 }, (_, row) => `${row},x`).join('\n'), ',', 4)
    expect(big.rows).toHaveLength(4)
    expect(big.more).toBe(true)
  })

  it('tells tabs from commas, and numbers from words', () => {
    expect(separatorOf('/a/t.tsv', 'a,b')).toBe('\t')
    expect(separatorOf('/a/t.csv', 'a\tb\tc,d\n1')).toBe('\t')
    expect(separatorOf('/a/t.csv', 'a,b\tc')).toBe(',')
    for (const cell of ['12', '-3.5', '$1,200', '45%', '€ 9']) expect(isNumberCell(cell)).toBe(true)
    for (const cell of ['Q3', '', 'n/a', '12 apples']) expect(isNumberCell(cell)).toBe(false)
  })
})
