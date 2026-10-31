import { describe, expect, it } from 'vitest'

import { fieldParts, fieldShows, fieldWords, offsetIn, pointAt } from './chipField'

/** A box drawn as ChipField draws it: words as text, a chip as a span that stands for its words. */
function drawn(...parts: (string | [agent: string, words: string] | 'BR')[]) {
  const root = document.createElement('div')
  for (const part of parts) {
    if (part === 'BR') root.append(document.createElement('br'))
    else if (typeof part === 'string') root.append(document.createTextNode(part))
    else {
      const chip = document.createElement('span')
      chip.dataset.agent = part[0]
      chip.dataset.words = part[1]
      chip.innerHTML = `<span class="tc-mention"><img alt=""><span>${part[1].slice(1)}</span></span>`
      root.append(chip)
    }
  }
  return root
}

describe('the message box’s words and what it draws', () => {
  it('cuts words into plain words and chips, in order, and leaves a chip that overlaps one as words', () => {
    expect(fieldParts('ask @Writer and @Ada', [{ start: 16, end: 20, agent: 'ada' }, { start: 4, end: 11, agent: 'writer' }, { start: 6, end: 13, agent: 'x' }])).toEqual([
      { kind: 'words', words: 'ask ', start: 0 },
      { kind: 'chip', words: '@Writer', start: 4, agent: 'writer' },
      { kind: 'words', words: ' and ', start: 11 },
      { kind: 'chip', words: '@Ada', start: 16, agent: 'ada' },
    ])
    expect(fieldParts('', [])).toEqual([])
  })

  it('reads a chip as the words it stands for, never what it shows', () => {
    expect(fieldWords(drawn('ask ', ['writer', '@writer'], ' now'))).toBe('ask @writer now')
  })

  it('reads a break at the very end as holding an empty line open, and any other as a line', () => {
    expect(fieldWords(drawn('one\n', 'BR'))).toBe('one\n')
    expect(fieldWords(drawn('one\n'))).toBe('one\n')
    expect(fieldWords(drawn('BR'))).toBe('')
    expect(fieldWords(drawn('one', 'BR', 'two'))).toBe('one\ntwo')
    // A browser that puts a new line in a block of its own starts a line there.
    const blocks = drawn('one')
    blocks.insertAdjacentHTML('beforeend', '<div>two</div><div><br></div>')
    expect(fieldWords(blocks)).toBe('one\ntwo\n')
  })

  it('knows when the box shows its words exactly, and when a browser left something behind', () => {
    const text = 'ask @Writer now'
    const parts = fieldParts(text, [{ start: 4, end: 11, agent: 'writer' }])
    expect(fieldShows(drawn('ask ', ['writer', '@Writer'], ' now'), parts, text)).toBe(true)
    // Words split over two runs of text are still the same words.
    expect(fieldShows(drawn('as', 'k ', ['writer', '@Writer'], ' now', ''), parts, text)).toBe(true)
    expect(fieldShows(drawn('ask @Writer now'), parts, text)).toBe(false)
    expect(fieldShows(drawn('ask ', ['researcher', '@Writer'], ' now'), parts, text)).toBe(false)
    const wrapped = drawn('ask ', ['writer', '@Writer'])
    wrapped.insertAdjacentHTML('beforeend', '<span style="font-size: 12px"> now</span>')
    expect(fieldShows(wrapped, parts, text)).toBe(false)
    // An empty last line needs its break; nothing else may have one.
    expect(fieldShows(drawn('one\n', 'BR'), fieldParts('one\n', []), 'one\n')).toBe(true)
    expect(fieldShows(drawn('one\n'), fieldParts('one\n', []), 'one\n')).toBe(false)
    expect(fieldShows(drawn('one', 'BR'), fieldParts('one', []), 'one')).toBe(false)
    expect(fieldShows(drawn(), [], '')).toBe(true)
  })

  it('counts a point in the box in words, a point inside a chip being at its end', () => {
    const root = drawn('ask ', ['writer', '@Writer'], ' now')
    document.body.append(root)
    expect(offsetIn(root, root.firstChild!, 2)).toBe(2)
    expect(offsetIn(root, root, 1)).toBe(4)
    expect(offsetIn(root, root, 2)).toBe(11)
    expect(offsetIn(root, (root.childNodes[1] as Element).querySelector('.tc-mention > span')!.firstChild!, 2)).toBe(11)
    expect(offsetIn(root, root.lastChild!, 3)).toBe(14)
    expect(offsetIn(root, document.body, 0)).toBe(0)
    root.remove()
  })

  it('finds the point for an offset in words, in the words beside a chip and never inside it', () => {
    const root = drawn('ask ', ['writer', '@Writer'], ['ada', '@Ada'], ' now', 'BR')
    const point = (offset: number) => {
      const at = pointAt(root, offset)
      return [at.node === root ? 'root' : at.node.textContent, at.offset]
    }
    expect(point(0)).toEqual(['ask ', 0])
    expect(point(4)).toEqual(['ask ', 4])
    expect(point(7)).toEqual(['root', 2])
    expect(point(11)).toEqual(['root', 2])
    expect(point(13)).toEqual(['root', 3])
    expect(point(15)).toEqual([' now', 0])
    expect(point(19)).toEqual([' now', 4])
    // The break that holds an empty last line open is never where words go.
    expect(point(40)).toEqual(['root', 4])
    expect(pointAt(drawn(['writer', '@Writer']), 7)).toMatchObject({ offset: 1 })
  })
})
