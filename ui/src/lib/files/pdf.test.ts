import { afterEach, describe, expect, it, vi } from 'vitest'

import { holdSelections, placeSlotOnPage } from './pdf'

/** Lays an element out at a box on screen, as jsdom lays nothing out. */
function at(element: Element, left: number, top: number, right: number, bottom: number) {
  const box = new DOMRect(left, top, right - left, bottom - top)
  element.getBoundingClientRect = () => box
  element.getClientRects = () => [box] as unknown as DOMRectList
}

afterEach(() => {
  vi.restoreAllMocks()
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

describe('a drag over the words of a PDF’s page (ADR 0091)', () => {
  const page = () => {
    document.body.innerHTML = '<div class="rd-pdf"><div class="rd-pdf-page"><div class="rd-pdf-text" style="width: 600px; height: 800px">'
      + '<span>First line.</span><span>Second line.</span><div class="endOfContent"></div></div></div></div>'
    const view = document.querySelector<HTMLElement>('.rd-pdf')!
    const words = view.querySelector<HTMLElement>('.rd-pdf-text')!
    return { view, words, end: words.querySelector<HTMLElement>('.endOfContent')!, first: words.querySelector('span')! }
  }
  const select = (node: Node, from: number, to: number) => {
    const range = document.createRange()
    range.setStart(node, from)
    range.setEnd(node, to)
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  }

  it('keeps to the words as it crosses blank paper, as PDF.js’s own viewer does, and lets go once the press ends', () => {
    const { view, words, end, first } = page()
    const stop = holdSelections(view)
    // Pressed on the words: the block after them covers the page, so blank paper ends on it.
    first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    document.dispatchEvent(new Event('pointerdown'))
    expect(words).toHaveClass('selecting')
    // In Safari it follows the end of the selection, so blank paper selects on from there, not from
    // the end of the page.
    select(first.firstChild!, 0, 5)
    expect(first.nextSibling).toBe(end)
    expect(end.style.width).toBe('600px')
    expect(end.style.getPropertyValue('-webkit-user-select')).toBe('text')
    // The press ends: the block goes back after the words, and the page is no longer being selected.
    document.dispatchEvent(new Event('pointerup'))
    expect(words.lastChild).toBe(end)
    expect(words).not.toHaveClass('selecting')
    expect(end.style.width).toBe('')
    expect(end.style.getPropertyValue('-webkit-user-select')).toBe('')
    // Stopped, it watches nothing.
    stop()
    first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(words).not.toHaveClass('selecting')
  })

  it.each([['Chrome/150', false], ['Chrome/148', false], ['Chrome/147', true], ['Chrome/140', true]])('leaves a browser that keeps the selection itself to it (%s moves the block: %s)', (browser, moves) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(`Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) ${browser}.0.0.0 Safari/537.36`)
    const { view, words, end, first } = page()
    const stop = holdSelections(view)
    first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    select(first.firstChild!, 0, 5)
    expect(first.nextSibling === end).toBe(moves)
    expect(words.lastChild === end).toBe(!moves)
    stop()
  })
})

describe('the bubbles after words asked about on a PDF’s page (ADR 0091)', () => {
  /** A page 600 by 800 whose line at 100 to 116 reads "North grew fastest" (marked), then the spans given. */
  const page = (...rest: [string, number, number, number, number][]) => {
    document.body.innerHTML = '<div class="rd-pdf-page"><div class="rd-pdf-text"><span>North grew <span class="rd-mark">fastest</span></span></div><div class="rd-pdf-slots"></div></div>'
    const words = document.querySelector('.rd-pdf-text')!
    const [line, mark] = words.querySelectorAll('span')
    at(line, 40, 100, 160, 116)
    at(mark, 100, 100, 160, 116)
    for (const [text, left, top, right, bottom] of rest) {
      const span = document.createElement('span')
      span.textContent = text
      at(span, left, top, right, bottom)
      words.append(span)
    }
    const layer = document.querySelector('.rd-pdf-slots')!
    at(layer, 0, 0, 600, 800)
    return { mark: mark as HTMLElement, layer }
  }
  const placed = (mark: HTMLElement) => {
    const slot = document.createElement('span')
    expect(placeSlotOnPage(slot, mark)).toBe(true)
    return slot.parentElement!
  }
  const across = (row: HTMLElement) => Number.parseFloat(row.style.left) * 6

  it('go in the first gap after the line wide enough for a bubble, at the middle of the line', () => {
    const { mark, layer } = page(['while West', 164, 100, 240, 116], ['held steady.', 244, 100, 330, 116], ['In the next column', 380, 100, 560, 116], ['A line well below', 40, 150, 500, 166])
    const row = placed(mark)
    expect(row.parentElement).toBe(layer)
    expect(row).toHaveClass('rd-pdf-row')
    // 330 across a page 600 wide, and 108 down a page 800 high.
    expect([row.style.left, row.style.top]).toEqual(['55%', '13.5%'])
    // Away from the words it follows, it is a pin in the margin, without a point.
    expect(row).toHaveClass('apart')
  })

  it('go past a gap narrower than a bubble, and past a line close enough above or below to be covered', () => {
    expect(across(placed(page(['held steady.', 164, 100, 330, 116], ['In a narrow gap', 350, 100, 520, 116]).mark))).toBeCloseTo(520)
    expect(across(placed(page(['A longer line just below', 40, 119, 420, 135]).mark))).toBeCloseTo(420)
  })

  it('cover the band of a tall line, from its middle', () => {
    // A line 40 high: half of it and a little is more than half a bubble.
    const { mark } = page(['A caption just under it', 164, 137, 400, 150])
    at(mark, 100, 100, 160, 140)
    expect(across(placed(mark))).toBeCloseTo(400)
  })

  it('after each line, go in a row of their own at that line', () => {
    const { mark, layer } = page()
    const second = document.createElement('span')
    second.innerHTML = 'A second <span class="rd-mark">line</span>'
    document.querySelector('.rd-pdf-text')!.append(second)
    at(second, 40, 150, 160, 166)
    const other = second.querySelector<HTMLElement>('.rd-mark')!
    at(other, 100, 150, 160, 166)
    const first = placed(mark)
    const next = placed(other)
    expect(next).not.toBe(first)
    expect(layer.querySelectorAll('.rd-pdf-row')).toHaveLength(2)
    // 158 down a page 800 high.
    expect(next.style.top).toBe('19.75%')
  })

  it('go right after the last word when the line ends there, with their point at it', () => {
    const row = placed(page().mark)
    expect(across(row)).toBeCloseTo(160)
    expect(row).not.toHaveClass('apart')
  })

  it('never hang more than a little past the page’s edge', () => {
    expect(across(placed(page(['to the very edge', 164, 100, 600, 116]).mark))).toBeCloseTo(580)
  })

  it('after one line, share a row in the order of their words', () => {
    const { mark } = page(['held steady.', 164, 100, 330, 116])
    const later = document.createElement('span')
    later.id = 'later'
    const earlier = document.createElement('span')
    earlier.id = 'earlier'
    // Parts are marked last first.
    placeSlotOnPage(later, mark)
    placeSlotOnPage(earlier, mark)
    expect(earlier.parentElement).toBe(later.parentElement)
    expect([...earlier.parentElement!.children].map((each) => each.id)).toEqual(['earlier', 'later'])
    expect(document.querySelectorAll('.rd-pdf-row')).toHaveLength(1)
  })

  it('are left to go after the words anywhere but on a page', () => {
    const loose = document.createElement('span')
    document.body.append(loose)
    expect(placeSlotOnPage(document.createElement('span'), loose)).toBe(false)
  })
})
