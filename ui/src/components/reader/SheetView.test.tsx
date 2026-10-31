import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseWorkbook, tableSheet, type Sheet } from '../../lib/files/cells'
import { SheetView, type CellEdit } from './SheetView'

const CSV = 'Region,Q1,Q2\nWest,120,140\nEast,80,95\n'

interface Shown { sheets?: Sheet[]; editable?: boolean; askable?: boolean; onCellEdit?: (edit: CellEdit) => void | Promise<unknown>; marking?: Parameters<typeof SheetView>[0]['marking'] }

function show({ sheets = [tableSheet(CSV, '/w/sales.csv')], editable = true, askable = false, onCellEdit = vi.fn(), marking = null }: Shown = {}) {
  const onMarked = vi.fn()
  const onOpen = vi.fn()
  const view = render(
    <SheetView sheets={sheets} askable={askable} ranges={[]} marking={marking} asking={null} open={null} dark={false}
      onMarked={onMarked} onOpen={onOpen} editable={editable} onCellEdit={onCellEdit} />,
  )
  return { ...view, onMarked, onOpen, onCellEdit }
}

const cell = (row: number, column: number) => document.querySelector<HTMLElement>(`[data-row="${row}"][data-column="${column}"]`)!
const box = () => screen.queryByRole('textbox')
const typeIn = (value: string) => fireEvent.change(box()!, { target: { value } })

afterEach(cleanup)

// ADR 0107: a cell of a sheet an agent made is changed where it is drawn.
describe('a cell of a sheet changed in place', () => {
  it('opens a cell on a double-click, with its words as shown, and saves what is typed on Enter by the sheet’s own row and column', () => {
    const { onCellEdit } = show()
    fireEvent.doubleClick(cell(2, 2))
    expect(box()).toHaveValue('120')
    expect(box()).toHaveAccessibleName('Change cell B2')
    expect(box()).toHaveFocus()
    expect(cell(2, 2)).toHaveClass('rd-cell-editing')
    typeIn('125')
    fireEvent.keyDown(box()!, { key: 'Enter' })
    expect(onCellEdit).toHaveBeenCalledTimes(1)
    expect(onCellEdit).toHaveBeenCalledWith({ sheet: null, row: 2, col: 2, value: '125', was: '120' })
    expect(box()).toBeNull()
    // The new words show until the sheet is read again, and the cell keeps the focus.
    expect(cell(2, 2)).toHaveTextContent('125')
    expect(cell(2, 2)).toHaveFocus()
  })

  it('puts the cell back on Esc, and saves nothing that wasn’t changed', () => {
    const { onCellEdit } = show()
    fireEvent.doubleClick(cell(3, 3))
    typeIn('999')
    fireEvent.keyDown(box()!, { key: 'Escape' })
    expect(box()).toBeNull()
    expect(cell(3, 3)).toHaveTextContent('95')
    expect(cell(3, 3)).toHaveFocus()
    fireEvent.doubleClick(cell(3, 3))
    fireEvent.blur(box()!)
    expect(box()).toBeNull()
    expect(onCellEdit).not.toHaveBeenCalled()
  })

  it('saves on leaving the cell, and Tab saves and goes on to the next cell, then to the next row', () => {
    const { onCellEdit } = show()
    fireEvent.doubleClick(cell(2, 1))
    typeIn('North')
    fireEvent.blur(box()!)
    expect(onCellEdit).toHaveBeenLastCalledWith({ sheet: null, row: 2, col: 1, value: 'North', was: 'West' })
    fireEvent.doubleClick(cell(2, 3))
    typeIn('150')
    fireEvent.keyDown(box()!, { key: 'Tab' })
    expect(onCellEdit).toHaveBeenLastCalledWith({ sheet: null, row: 2, col: 3, value: '150', was: '140' })
    // Past the row's last cell, the next row's first.
    expect(cell(3, 1)).toHaveFocus()
    expect(cell(3, 1)).toHaveAttribute('tabindex', '0')
    expect(cell(2, 3)).toHaveAttribute('tabindex', '-1')
  })

  it('reaches cells from the keyboard: arrows move, Enter opens one, and typing types over it', () => {
    const { onCellEdit } = show()
    // One tab stop on the sheet, on its first cell under the column names.
    expect(document.querySelectorAll('[tabindex="0"]')).toHaveLength(1)
    expect(cell(2, 1)).toHaveAttribute('tabindex', '0')
    cell(2, 1).focus()
    fireEvent.keyDown(cell(2, 1), { key: 'ArrowRight' })
    expect(cell(2, 2)).toHaveFocus()
    fireEvent.keyDown(cell(2, 2), { key: 'ArrowDown' })
    expect(cell(3, 2)).toHaveFocus()
    fireEvent.keyDown(cell(3, 2), { key: 'ArrowDown' })
    expect(cell(3, 2)).toHaveFocus()
    fireEvent.keyDown(cell(3, 2), { key: 'Enter' })
    expect(box()).toHaveValue('80')
    fireEvent.keyDown(box()!, { key: 'Escape' })
    fireEvent.keyDown(cell(3, 2), { key: '7' })
    expect(box()).toHaveValue('7')
    fireEvent.keyDown(box()!, { key: 'Enter' })
    expect(onCellEdit).toHaveBeenCalledWith({ sheet: null, row: 3, col: 2, value: '7', was: '80' })
    // The column names are cells too: a column can be renamed.
    fireEvent.keyDown(cell(3, 2), { key: 'ArrowUp' })
    fireEvent.keyDown(cell(2, 2), { key: 'ArrowUp' })
    expect(cell(1, 2)).toHaveFocus()
    fireEvent.keyDown(cell(1, 2), { key: 'Backspace' })
    expect(box()).toHaveValue('')
  })

  it('numbers a workbook’s cells by the sheet’s own rows and columns when its cells start right of and below A1', () => {
    const text = 'Sheet 1 of 2: Summary (1 row, 1 column)\nTotal\n\nSheet 2 of 2: By region (3 rows, 2 columns, from cell C3)\nRegion\tSales\nWest\t260\n\nEast\t175\n\n'
    const sheets = parseWorkbook(text)
    const { onCellEdit } = show({ sheets })
    fireEvent.click(screen.getByRole('tab', { name: 'By region' }))
    // West is in C4, and East in C6, past the sheet's empty row.
    expect(cell(4, 3)).toHaveTextContent('West')
    expect(cell(6, 4)).toHaveTextContent('175')
    fireEvent.doubleClick(cell(4, 4))
    expect(box()).toHaveAccessibleName('Change cell D4')
    typeIn('270')
    fireEvent.keyDown(box()!, { key: 'Enter' })
    expect(onCellEdit).toHaveBeenLastCalledWith({ sheet: 'By region', row: 4, col: 4, value: '270', was: '260' })
    fireEvent.doubleClick(cell(6, 3))
    typeIn('South')
    fireEvent.keyDown(box()!, { key: 'Enter' })
    expect(onCellEdit).toHaveBeenLastCalledWith({ sheet: 'By region', row: 6, col: 3, value: 'South', was: 'East' })
  })

  it('shows the old words again when the change wasn’t saved', async () => {
    let fail: (saved: boolean) => void = () => {}
    show({ onCellEdit: () => new Promise((done) => { fail = done }) })
    fireEvent.doubleClick(cell(2, 2))
    typeIn('125')
    fireEvent.keyDown(box()!, { key: 'Enter' })
    expect(cell(2, 2)).toHaveTextContent('125')
    await act(async () => { fail(false) })
    expect(cell(2, 2)).toHaveTextContent('120')
  })

  it('still marks cells by a press and a drag, and opening a cell to type in lets go of the cells marked', () => {
    const { onMarked, rerender, onCellEdit } = show({ askable: true })
    const grid = document.querySelector<HTMLElement>('.rd-grid')!
    let over: Element = cell(2, 2)
    const was = document.elementFromPoint
    document.elementFromPoint = () => over
    fireEvent.pointerDown(cell(2, 2), { button: 0, pointerId: 1 })
    over = cell(3, 3)
    fireEvent.pointerMove(grid, { pointerId: 1 })
    fireEvent.pointerUp(grid, { pointerId: 1 })
    document.elementFromPoint = was
    expect(onMarked).toHaveBeenLastCalledWith(expect.objectContaining({ sheet: null, range: { top: 2, left: 2, bottom: 3, right: 3 } }))
    expect(box()).toBeNull()
    const marking = { sheet: null, range: { top: 2, left: 2, bottom: 3, right: 3 } }
    rerender(<SheetView sheets={[tableSheet(CSV, '/w/sales.csv')]} askable ranges={[]} marking={marking} asking={null} open={null} dark={false}
      onMarked={onMarked} onOpen={vi.fn()} editable onCellEdit={onCellEdit} />)
    fireEvent.doubleClick(cell(3, 3))
    expect(onMarked).toHaveBeenLastCalledWith(null)
    expect(box()).toHaveValue('95')
    // A press on another cell saves the one being typed in first.
    typeIn('96')
    fireEvent.pointerDown(cell(2, 1), { button: 0, pointerId: 2 })
    expect(onCellEdit).toHaveBeenCalledWith({ sheet: null, row: 3, col: 3, value: '96', was: '95' })
    expect(box()).toBeNull()
  })

  it('changes nothing unless the sheet can be changed', () => {
    const { onCellEdit } = show({ editable: false })
    expect(document.querySelectorAll('[tabindex]')).toHaveLength(0)
    expect(screen.getByRole('table')).toBeInTheDocument()
    fireEvent.doubleClick(cell(2, 2))
    expect(box()).toBeNull()
    fireEvent.keyDown(cell(2, 2), { key: 'Enter' })
    fireEvent.keyDown(cell(2, 2), { key: 'x' })
    expect(box()).toBeNull()
    expect(onCellEdit).not.toHaveBeenCalled()
  })
})
