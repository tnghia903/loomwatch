import { fireEvent } from '@testing-library/react'

import { fieldWords, pointAt } from '../lib/chat/chipField'

/**
 * Leaves `text` in a message box (ChipField) as typing would: the words in it, the caret at
 * `caret` (the end by default), and the browser's `input` saying letters were typed.
 */
export function typeInto(field: HTMLElement, text: string, caret = text.length) {
  field.focus()
  field.replaceChildren(document.createTextNode(text))
  caretAt(field, caret)
  fireEvent.input(field, { inputType: 'insertText' })
}

/** Puts the caret `offset` into the box's words (a chip counts as the words it stands for). */
export function caretAt(field: HTMLElement, offset: number, end = offset) {
  const from = pointAt(field, offset)
  const to = pointAt(field, end)
  const range = document.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

/** The words in a message box, each chip as the words it stands for: what would be sent. */
export const wordsIn = (field: HTMLElement) => fieldWords(field)
