import { describe, expect, it } from 'vitest'

import { markParts } from './partMarks'
import { findPassage, pageText } from './passage'

const page = (html: string) => {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.append(root)
  return root
}
const NAMES = { mark: 'mark', slot: 'slot' }

describe('marking parts of a page in place', () => {
  it('wraps a part’s words, across elements, and leaves a slot after its last word', () => {
    const root = page('<p>Next actions often relate to recent ones. SASRec beat <b>Markov-chain</b> and RNN baselines.</p>')
    const range = findPassage(pageText(root), 'beat Markov-chain')!
    const { parts } = markParts([{ key: 'a', range }], NAMES)
    expect(parts.get('a')!.marks.map((mark) => mark.textContent)).toEqual(['beat ', 'Markov-chain'])
    expect(root.innerHTML).toBe('<p>Next actions often relate to recent ones. SASRec <span class="mark" data-part="a">beat </span><b><span class="mark" data-part="a">Markov-chain</span><span class="slot" data-part="a" data-reader-chrome="" contenteditable="false"></span></b> and RNN baselines.</p>')
  })

  it('puts back every text node as it was, the same nodes with the same words, however the parts fell', () => {
    const root = page('<p>Every item becomes a short list of numbers. This is an embedding.</p><ul><li>Shoes</li><li>Shorts</li></ul>')
    const before = root.innerHTML
    const nodes = [...root.querySelectorAll('p, li')].map((element) => element.firstChild)
    const text = pageText(root)
    const { parts, undo } = markParts([
      { key: 'whole', range: findPassage(text, 'Every item')! },
      { key: 'middle', range: findPassage(text, 'an embedding')! },
      { key: 'across', range: findPassage(text, 'Shoes Shorts')! },
    ], NAMES)
    expect([...parts.keys()].sort()).toEqual(['across', 'middle', 'whole'])
    expect(root.textContent).toBe('Every item becomes a short list of numbers. This is an embedding.ShoesShorts')
    undo()
    expect(root.innerHTML).toBe(before)
    // React keeps these nodes: they must be the ones it made, not copies.
    const after = [...root.querySelectorAll('p, li')].map((element) => element.firstChild)
    nodes.forEach((node, index) => expect(after[index]).toBe(node))
    expect(root.querySelector('p')!.childNodes).toHaveLength(1)
  })

  it('marks the newer of two parts that overlap, and shows the older with it', () => {
    const root = page('<p>Sales grew 12% in Q3.</p>')
    const text = pageText(root)
    const { parts, undo } = markParts([
      { key: 'first', range: findPassage(text, 'Sales grew')! },
      { key: 'overlap', range: findPassage(text, 'grew 12%')! },
    ], NAMES)
    expect(root.querySelectorAll('.mark')).toHaveLength(1)
    expect(root.querySelector('.mark')).toHaveTextContent('grew 12%')
    // The older part's bubble has a place: the newer one's slot, after the words marked.
    expect(parts.get('overlap')!.key).toBe('overlap')
    expect(parts.get('first')).toBe(parts.get('overlap'))
    expect(root.querySelectorAll('.slot')).toHaveLength(1)
    undo()
    expect(root.innerHTML).toBe('<p>Sales grew 12% in Q3.</p>')
  })
})
