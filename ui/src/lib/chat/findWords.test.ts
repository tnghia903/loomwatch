import { describe, expect, it } from 'vitest'
import { fold, matchesIn, plainWords, segments, snippet, type FindTerm } from './findWords'

const term = (text: string, prefix: boolean): FindTerm => ({ text, prefix })

describe('folding, as the daemon folds (chat_find::tests)', () => {
  it.each([
    ['Đường phố Đà Nẵng', 'duong pho da nang'],
    ['Tái chế ắc quy', 'tai che ac quy'],
    ['Label CLIPPING', 'label clipping'],
    ['naïve café', 'naive cafe'],
    ['emoji 🙂 stays', 'emoji 🙂 stays'],
  ])('%s', (text, folded) => {
    expect(fold(text)).toBe(folded)
    expect(fold(text)).toHaveLength(text.length)
  })
})

describe('finding words where they are shown', () => {
  it('lights whole words a term finds, in the original text', () => {
    const text = 'History labels at the left edge clip: Label clipping fixed.'
    const lit = matchesIn(text, [term('label', true), term('clip', true)]).map(([start, end]) => text.slice(start, end))
    expect(lit).toEqual(['labels', 'clip', 'Label', 'clipping'])
  })

  it('finds Vietnamese without its accents, and a short word only whole', () => {
    const text = 'Đi Đà Nẵng, đang ở Đà Lạt'
    const lit = matchesIn(text, [term('da', false), term('nang', true)]).map(([start, end]) => text.slice(start, end))
    expect(lit).toEqual(['Đà', 'Nẵng', 'Đà'])
  })

  it('splits text into lit and plain pieces that add back up to it', () => {
    const text = 'clip the label'
    const parts = segments(text, [term('label', true)])
    expect(parts).toEqual([{ text: 'clip the ', hit: false }, { text: 'label', hit: true }])
    expect(parts.map((part) => part.text).join('')).toBe(text)
    expect(segments(text, [])).toEqual([{ text, hit: false }])
  })

  it('reads markdown as its words and cuts a long one around the first match', () => {
    expect(plainWords('## Title\n\n**Bold** and [a link](https://x.test) and `code`')).toBe('Title Bold and a link and code')
    const long = `${'Before. '.repeat(40)}The recycling rate was wrong. ${'After. '.repeat(40)}`
    const cut = snippet(long, [term('recycl', true)], 80)
    expect(cut.startsWith('…') && cut.endsWith('…')).toBe(true)
    expect(cut).toContain('recycling rate')
    expect(cut.length).toBeLessThanOrEqual(82)
  })
})
