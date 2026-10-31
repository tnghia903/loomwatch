import type { Element, Slide } from 'pptxtojson'
import { describe, expect, it } from 'vitest'

import { deckChanges, deckSeen } from './deckSeen'
import { PAGE_BRIDGE } from './pageFrame'
import { slidesPage, textContent, type ParsedDeck } from './slidesPage'

const box = { left: 36, top: 72, width: 288, height: 108, rotate: 0, isFlipH: false, isFlipV: false, order: 1 }
const plain = { borderColor: '', borderWidth: 0, borderType: 'solid' as const, borderStrokeDasharray: '0', fill: { type: 'color' as const, value: '' } }
const words = (content: string, extra: Record<string, unknown> = {}): Element => ({ type: 'text', id: 't', name: 'Text 1', ...box, ...plain, isVertical: false, content, vAlign: 'up', wrap: true, ...extra }) as Element
const slide = (elements: Element[], extra: Partial<Slide> = {}): Slide => ({ fill: { type: 'color', value: '#FFFFFF' }, elements, layoutElements: [], note: '', ...extra })
const deck = (slides: Slide[]): ParsedDeck => ({ size: { width: 960, height: 540 }, slides })
/** The drawn page, read back as a document. */
const drawn = (parsed: ParsedDeck, name = 'deck.pptx', marks?: Parameters<typeof slidesPage>[3]) => new DOMParser().parseFromString(slidesPage(parsed, name, undefined, marks), 'text/html')
/** The page in a frame of its own, as the reader shows it, its script run. */
function live(parsed: ParsedDeck, marks?: Parameters<typeof slidesPage>[3], { placed = false } = {}) {
  const page = drawn(parsed, 'deck.pptx', marks)
  const holder = document.createElement('iframe')
  document.body.appendChild(holder)
  const inner = holder.contentWindow! as Window & typeof globalThis
  const doc = holder.contentDocument!
  doc.head.innerHTML = page.head.innerHTML
  doc.body.innerHTML = page.body.innerHTML
  inner.scrollTo = () => {}
  // jsdom lays nothing out: each part is where the deck puts it, in points, the slide at their scale.
  if (placed) {
    inner.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const [left, top, width, height] = this.classList.contains('lw-frame') ? [0, 0, 960, 540] : ['left', 'top', 'width', 'height'].map((side) => parseFloat(this.style.getPropertyValue(side)) || 0)
      return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect
    }
  }
  new inner.Function(page.querySelector('script')!.textContent!)()
  const shown = () => [...doc.querySelectorAll<HTMLElement>('.lw-slide')].filter((section) => !section.hidden).map((section) => section.querySelector('h2')!.textContent)
  const steps = () => [...doc.querySelectorAll('.lw-slide:not([hidden]) .lw-step')].map((step) => step.getAttribute('aria-current'))
  const said = () => [...doc.querySelectorAll('.lw-slide:not([hidden]) .lw-said')].map((part) => part.textContent)
  const press = (key: string, extra: KeyboardEventInit = {}) => inner.dispatchEvent(new inner.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }))
  const told = () => doc.getElementById('lw-told')!.textContent
  return { inner, doc, shown, steps, said, press, told, done: () => holder.remove() }
}
const p = (said: string) => `<p>${said}</p>`

describe('a slide deck drawn as a page', () => {
  it('draws each slide at its own size, under its number, scaled to the page, one at a time, with its notes under it', () => {
    const page = drawn(deck([slide([words('<p>One</p>')], { note: '<p>Say hello.</p>' }), slide([words('<p>Two</p>')])]), 'Q3 <review>.pptx')
    expect(page.title).toBe('Q3 <review>.pptx')
    expect([...page.querySelectorAll('h2')].map((heading) => heading.textContent)).toEqual(['Slide 1 of 2', 'Slide 2 of 2'])
    expect([...page.querySelectorAll('section')].map((section) => section.hidden)).toEqual([false, true])
    // A part picked on a slide is named by the heading it is under.
    expect(page.querySelector('section')!.getAttribute('aria-labelledby')).toBe(page.querySelector('h2')!.id)
    const canvas = page.querySelector<HTMLElement>('.lw-canvas')!
    expect([canvas.style.width, canvas.style.height]).toEqual(['960pt', '540pt'])
    expect(page.querySelector<HTMLElement>('.lw-frame')!.getAttribute('style')).toBe('aspect-ratio:960/540')
    expect(page.querySelector('script')!.textContent).toContain('1280.000')
    const part = page.querySelector<HTMLElement>('.lw-el')!
    expect([part.style.left, part.style.top, part.style.width, part.style.height]).toEqual(['36pt', '72pt', '288pt', '108pt'])
    // Its notes are words to read and ask about as any, under a heading that names their slide.
    expect(page.querySelector('details')).toBeNull()
    const notes = page.querySelectorAll('section')[0].querySelector('.lw-notes')!
    expect(notes.querySelector('h3')!.textContent).toBe('Notes, slide 1')
    expect(notes.querySelector('.lw-hidden')!.textContent).toBe(', slide 1')
    expect(notes.querySelector('.lw-step-words')!.textContent).toBe('Say hello.')
    // Notes of one step have nothing to walk.
    expect(notes.querySelector('.lw-knots')).toBeNull()
    // A slide with no notes has no notes heading, only the buttons that walk on.
    expect(page.querySelectorAll('section')[1].querySelector('.lw-notes-label')).toBeNull()
    expect(page.querySelectorAll('section')[1].querySelectorAll('.lw-walk-turn button')).toHaveLength(2)
    expect(drawn(deck([slide([])])).querySelector('h2')!.textContent).toBe('Slide 1')
  })

  it('draws a strip of every slide beside them, a button for each, and none for a deck of one slide', () => {
    const page = drawn(deck([slide([words('<p>One</p>')]), slide([words('<p>Two</p>')]), slide([])]))
    const strip = page.querySelector('nav.lw-strip')!
    expect(strip.getAttribute('aria-label')).toBe('Slides')
    expect([...strip.querySelectorAll('button')].map((thumb) => thumb.getAttribute('aria-label'))).toEqual(['Slide 1', 'Slide 2', 'Slide 3'])
    expect(strip.querySelector('.lw-thumb-paper')!.getAttribute('style')).toBe('aspect-ratio:960/540')
    const single = drawn(deck([slide([])]))
    expect(single.querySelector('.lw-strip')).toBeNull()
    expect(single.querySelector('.lw-turn')).toBeNull()
    expect(single.querySelector('.lw-reader')!.classList.contains('single')).toBe(true)

    // At work: each copy of a slide is drawn in, inert and named by nothing, and a press on one
    // shows its slide, ringed in the strip; the buttons at the top go a slide either way.
    const page2 = live(deck([slide([words('<p>One</p>')]), slide([words('<p>Two</p>', { id: 'second' })]), slide([])]))
    try {
      const thumbs = [...page2.doc.querySelectorAll<HTMLButtonElement>('.lw-thumb')]
      const copies = thumbs.map((thumb) => thumb.querySelector('.lw-thumb-paper .lw-canvas'))
      expect(copies.map((copy) => [copy?.hasAttribute('inert'), copy?.getAttribute('aria-hidden')])).toEqual([[true, 'true'], [true, 'true'], [true, 'true']])
      expect(copies[1]!.querySelector('[id]')).toBeNull()
      expect(page2.shown()).toEqual(['Slide 1 of 3'])
      const before = page2.doc.querySelector<HTMLButtonElement>('.lw-slide-before')!
      const after = page2.doc.querySelector<HTMLButtonElement>('.lw-slide-after')!
      expect([before.disabled, after.disabled]).toEqual([true, false])
      thumbs[2]!.click()
      expect(page2.shown()).toEqual(['Slide 3 of 3'])
      expect(thumbs.map((thumb) => thumb.getAttribute('aria-current'))).toEqual([null, null, 'true'])
      expect([before.disabled, after.disabled]).toEqual([false, true])
      expect(page2.told()).toBe('Slide 3 of 3')
      before.click()
      expect(page2.shown()).toEqual(['Slide 2 of 3'])
    } finally {
      page2.done()
    }
  })

  it('walks a slide’s notes a step at a time, the parts each step is about lit, then on to the next slide', () => {
    const lanes = slide([words(p('Batch (offline)')), words(p('Query (online)'), { left: 400 }), words(p('Footer'), { top: 400 })], {
      note: [p('Walk it left to right.'), p(''), p('Batch (offline): the batch lane first.'), p(''), p('Query (online): then the query lane.')].join(''),
    })
    const page = live(deck([lanes, slide([words(p('Close'))], { note: p('Close.') }), slide([])]))
    try {
      const first = page.doc.querySelector('.lw-slide')!
      const canvas = first.querySelector('.lw-canvas')!
      const dots = first.querySelector('.lw-step-dots')!
      const knots = () => [...first.querySelectorAll('.lw-step-dot')].map((dot) => (dot.classList.contains('lw-now') ? 'now' : dot.classList.contains('lw-past') ? 'past' : 'to come'))
      const walk = () => [...first.querySelectorAll<HTMLButtonElement>('.lw-walk-turn button')].map((button) => [button.getAttribute('aria-label'), button.title, button.disabled])
      expect(first.querySelectorAll('.lw-step-dot')).toHaveLength(3)
      expect([page.steps(), knots(), dots.getAttribute('aria-label')]).toEqual([['step', null, null], ['now', 'to come', 'to come'], 'Step 1 of 3'])
      // The buttons say where they go: back from the deck's first step, nowhere.
      expect(walk()).toEqual([['Previous slide', 'Previous slide (←)', true], ['Next step', 'Next step (→)', false]])
      // A step about no part lights none, and nothing steps back.
      expect([page.said(), canvas.classList.contains('lw-saying')]).toEqual([[], false])

      page.press('ArrowRight')
      expect([page.steps(), knots(), page.said()]).toEqual([[null, 'step', null], ['past', 'now', 'to come'], ['Batch (offline)']])
      expect([dots.getAttribute('aria-label'), dots.getAttribute('style')]).toEqual(['Step 2 of 3', '--lw-walked: 0.5;'])
      expect(walk()).toEqual([['Previous step', 'Previous step (←)', false], ['Next step', 'Next step (→)', false]])
      expect(canvas.classList.contains('lw-saying')).toBe(true)
      expect(page.told()).toBe('Step 2 of 3')
      first.querySelector<HTMLButtonElement>('.lw-step-next')!.click()
      expect([page.steps(), page.said()]).toEqual([[null, null, 'step'], ['Query (online)']])
      // From the slide's last step, the next is a slide.
      expect(walk()[1]).toEqual(['Next slide', 'Next slide (→)', false])

      // After the last step, the next slide; back, the last step of the slide before.
      page.press('ArrowRight')
      expect([page.shown(), page.steps(), page.told()]).toEqual([['Slide 2 of 3'], ['step'], 'Slide 2 of 3'])
      page.press('ArrowLeft')
      expect([page.shown(), page.steps(), page.said()]).toEqual([['Slide 1 of 3'], [null, null, 'step'], ['Query (online)']])

      // A step pressed is said; one pointed at lights its parts until the pointer leaves.
      const items = [...first.querySelectorAll<HTMLElement>('.lw-step')]
      items[0]!.click()
      expect([page.steps(), page.said()]).toEqual([['step', null, null], []])
      items[1]!.dispatchEvent(new page.inner.MouseEvent('mouseenter'))
      expect(page.said()).toEqual(['Batch (offline)'])
      items[1]!.dispatchEvent(new page.inner.MouseEvent('mouseleave'))
      expect(page.said()).toEqual([])
      // A part pressed on the slide goes to the step about it.
      canvas.querySelectorAll<HTMLElement>('.lw-el')[1]!.querySelector<HTMLElement>('p')!.click()
      expect(page.steps()).toEqual([null, null, 'step'])
      canvas.querySelectorAll<HTMLElement>('.lw-el')[2]!.click()
      expect(page.steps()).toEqual([null, null, 'step'])

      // While the Pick switch is on, the keys and a press are the Pick switch's.
      page.doc.documentElement.classList.add('lw-picking')
      page.press('ArrowLeft')
      items[0]!.click()
      expect(page.steps()).toEqual([null, null, 'step'])
      page.doc.documentElement.classList.remove('lw-picking')
      // So is a key the page has already taken, and one with Shift held, which marks words.
      page.inner.addEventListener('keydown', (event) => event.preventDefault(), { capture: true, once: true })
      page.press('ArrowLeft')
      page.press('ArrowLeft', { shiftKey: true })
      expect(page.steps()).toEqual([null, null, 'step'])

      // Page Down and Up, Home and End go by slides.
      page.press('PageDown')
      expect(page.shown()).toEqual(['Slide 2 of 3'])
      page.press('End')
      expect([page.shown(), page.steps()]).toEqual([['Slide 3 of 3'], []])
      // A slide with no notes still has the walk's buttons; at the deck's end, there is no next.
      const last = [...page.doc.querySelectorAll<HTMLButtonElement>('.lw-slide:not([hidden]) .lw-walk-turn button')]
      expect(last.map((button) => [button.getAttribute('aria-label'), button.disabled])).toEqual([['Previous slide', false], ['Next slide', true]])
      page.press('ArrowRight')
      expect(page.shown()).toEqual(['Slide 3 of 3'])
      last[0]!.click()
      expect([page.shown(), page.steps()]).toEqual([['Slide 2 of 3'], ['step']])
      page.press('End')
      page.press('Home')
      expect([page.shown(), page.steps()]).toEqual([['Slide 1 of 3'], ['step', null, null]])
    } finally {
      page.done()
    }
  })

  it('rings each part a step is about, a little out from it, and parts that touch in one ring', () => {
    const near = slide([words(p('Batch lane'), { width: 290 }), words(p('Snapshot export'), { left: 330, width: 100 }), words(p('Evidence gate'), { left: 700, width: 100 })], {
      note: [p('Batch lane: the snapshot export.'), p(''), p('Batch lane, then the evidence gate.')].join(''),
    })
    const page = live(deck([near]), undefined, { placed: true })
    try {
      const rings = () => [...page.doc.querySelectorAll<HTMLElement>('.lw-ring')].map((ring) => [ring.style.left, ring.style.top, ring.style.width, ring.style.height])
      // Two parts 6 points apart: one ring round both.
      expect(page.said()).toEqual(['Batch lane', 'Snapshot export'])
      expect(rings()).toEqual([['32px', '68px', '402px', '116px']])
      page.press('ArrowRight')
      expect(rings()).toEqual([['32px', '68px', '298px', '116px'], ['696px', '68px', '108px', '116px']])
    } finally {
      page.done()
    }
  })

  it('lights a table’s row when a step is about it, its other rows stepped back', () => {
    const cell = (text: string) => ({ text: `<p>${text}</p>`, borders: {} })
    const table = { type: 'table', id: 'tb', ...box, borders: {}, data: [
      [cell('Factor'), cell('What we do')],
      [cell('Data boundary'), cell('Company data stays in Azure')],
      [cell('Cost control'), cell('A monthly budget with an alert')],
    ] } as unknown as Element
    const note = [p('Each row is a requirement.'), p(''), p('1. Data boundary: data only in Azure.'), p('2. Cost: a monthly budget and an alert.')].join('')
    const keys = [...drawn(deck([slide([table], { note })])).querySelectorAll('td')].map((td) => td.getAttribute('data-lw-part'))
    // The first row and the first column name the others: each cell is in its row and its column.
    expect(keys).toEqual([null, '0c1', '0r1', '0r1 0c1', '0r2', '0r2 0c1'])
    const page = live(deck([slide([table], { note })]))
    try {
      const kept = () => [...page.doc.querySelectorAll('.lw-keep')].map((cell) => cell.textContent)
      page.press('ArrowRight')
      expect(page.said()).toEqual(['Data boundary', 'Company data stays in Azure'])
      // A lit row is read under the column names, which stay whole.
      expect(kept()).toEqual(['Factor', 'What we do'])
      page.press('ArrowRight')
      expect(page.said()).toEqual(['Cost control', 'A monthly budget with an alert'])
      page.press('ArrowLeft')
      page.press('ArrowLeft')
      expect([page.said(), kept()]).toEqual([[], []])
    } finally {
      page.done()
    }
  })

  it('marks what changed since the deck was last seen: the slide in the strip and by its number with the agent’s face, the parts, the notes', () => {
    const face = 'data:image/webp;base64,UklGRg=='
    const box = (said: string) => words(`<p>${said}</p>`, { id: 'b', left: 300 })
    const before = deck([slide([words('<p>Title</p>'), box('Snapshot export (code built)')]), slide([], { note: '<p>Hi</p>' }), slide([])])
    const after = deck([slide([words('<p>Title</p>'), box('Snapshot export')]), slide([], { note: '<p>Hi there</p>' }), slide([])])
    const page = drawn(after, 'deck.pptx', { changes: deckChanges(deckSeen(before), deckSeen(after)), face })
    const thumbs = [...page.querySelectorAll('.lw-thumb')]
    expect(thumbs.map((thumb) => thumb.getAttribute('aria-label'))).toEqual(['Slide 1, changed since you last looked', 'Slide 2, changed since you last looked', 'Slide 3'])
    expect(thumbs.map((thumb) => [thumb.classList.contains('changed'), Boolean(thumb.querySelector('.lw-thumb-stitch')), thumb.querySelector('img')?.getAttribute('src') ?? null]))
      .toEqual([[true, true, face], [true, true, face], [false, false, null]])
    // On the slide: its number carries the stitch and the face, said and shown on hover, its words
    // still only its number; only the part that changed carries the stitch, and the notes theirs.
    const first = page.querySelectorAll('section')[0]
    const mark = first.querySelector('h2 .lw-change-mark')!
    expect([mark.getAttribute('role'), mark.getAttribute('aria-label'), mark.getAttribute('title')]).toEqual(['img', 'Changed since you last looked', 'Changed since you last looked'])
    expect(mark.querySelector('img')!.getAttribute('src')).toBe(face)
    expect(first.querySelector('h2')!.textContent).toBe('Slide 1 of 3')
    expect([...first.querySelectorAll('.lw-canvas > .lw-el')].map((part) => part.classList.contains('lw-changed'))).toEqual([false, true])
    const notes = page.querySelectorAll('section')[1].querySelector('.lw-notes')!
    expect(notes.querySelector('h3 .lw-change-mark')).not.toBeNull()
    expect(notes.querySelector('h3')!.textContent).toBe('Notes, slide 2')
    expect(page.querySelectorAll('section')[2].querySelector('.lw-change-mark')).toBeNull()
    expect(thumbs[0].getAttribute('title')).toBe('Changed since you last looked')
    // The stitch is the change's mark, a dashed outline Pick's.
    expect(page.querySelectorAll('section')[0].classList.contains('changed')).toBe(true)
    const html = slidesPage(after, 'deck.pptx', undefined, { changes: deckChanges(deckSeen(before), deckSeen(after)), face })
    expect(html).not.toMatch(/\.lw-changed\{outline/)
    // The page opens at the first slide that changed, ringed in the strip.
    const later = deck([slide([]), slide([words('<p>New</p>')]), slide([])])
    const opened = drawn(later, 'deck.pptx', { changes: deckChanges(deckSeen(deck([slide([]), slide([]), slide([])])), deckSeen(later)), face })
    expect([...opened.querySelectorAll('section')].map((section) => section.hidden)).toEqual([true, false, true])
    expect([...opened.querySelectorAll('.lw-thumb')].map((thumb) => thumb.getAttribute('aria-current'))).toEqual([null, 'true', null])
    expect(opened.querySelector<HTMLButtonElement>('.lw-slide-before')!.disabled).toBe(false)
    // The agent's face is beside the step being said.
    expect(slidesPage(deck([slide([], { note: p('Hi') })]), 'deck.pptx', undefined, { changes: null, face })).toContain(`.lw-step-face{flex-shrink:0;width:20px;height:22px;background:url("${face}")`)
    // A face that isn't a picture's data is never put in the page.
    const odd = drawn(after, 'deck.pptx', { changes: deckChanges(deckSeen(before), deckSeen(after)), face: 'https://example.com/face.png' })
    expect(odd.querySelector('img')).toBeNull()
  })

  it('names nothing in the page as the reader’s own marks in it do, so their styles never reach the slides', () => {
    const before = deck([slide([words('<p>A</p>')], { note: '<p>n</p>' }), slide([], { fill: { type: 'color', value: '#111111' } })])
    const after = deck([slide([words('<p>B</p>')], { note: '<p>m</p>' }), slide([words('<p>C</p>')], { fill: { type: 'color', value: '#111111' } })])
    const page = live(after, { changes: deckChanges(deckSeen(before), deckSeen(after)), face: 'data:image/webp;base64,UklGRg==' })
    // What the page's own script names too, as a step is said, and its styles.
    page.press('ArrowRight')
    const named = [...page.doc.querySelectorAll('[class]')].flatMap((element) => [...element.classList])
    const style = page.doc.querySelector('style')!.textContent!
    // The slides' styles step around the reader's own marks in the words (`lw-mark`, `lw-slot`) and
    // answer to the Pick switch's mark on the page (`lw-picking`); they never set them.
    const answered = new Set(['lw-picking', 'lw-mark', 'lw-slot'])
    const styled = style.match(/\.lw-[a-z-]+/g)!.map((name) => name.slice(1)).filter((name) => !answered.has(name))
    page.done()
    const ours = new Set([...named, ...styled].filter((name) => name.startsWith('lw-')))
    expect(named.filter((name) => answered.has(name))).toEqual([])
    // And a rule reaching into a step's words leaves the reader's marks and bubbles as it draws them.
    const intoWords = [...style.matchAll(/([^{}]*\.lw-step-words [^{}]*)\{/g)].map((rule) => rule[1]!)
    expect(intoWords.length).toBeGreaterThan(1)
    expect(intoWords.filter((selector) => !/:not\([^)]*\.lw-slot,\.lw-slot \*\)/.test(selector) && !/ (p\+p|li\+li|br|p)\b/.test(selector))).toEqual([])
    expect(ours.has('lw-said')).toBe(true)
    const theirs = new Set(PAGE_BRIDGE.match(/\.lw-[a-z-]+/g)!.map((name) => name.slice(1)))
    expect(ours.size).toBeGreaterThan(10)
    expect([...ours].filter((name) => theirs.has(name))).toEqual([])
  })

  it('draws a change and a ring in whichever gold stands out more on the slide: bright on dark and mid-tone slides, the paper’s on light ones', () => {
    const fills = ['#1F2937', '#4472C4', '#7F7F7F', '#FFFFFF', '#EEF0F3', '#A5A5A5']
    const page = drawn(deck(fills.map((value) => slide([words('<p>x</p>')], { fill: { type: 'color', value } }))))
    // Office's blue and a mid grey are where the paper gold all but vanishes (1.1:1, 1.3:1).
    expect([...page.querySelectorAll('.lw-canvas')].map((canvas) => canvas.classList.contains('lw-dark-slide'))).toEqual([true, true, true, false, false, false])
  })

  it('reads a slide’s words as the deck does: breaking spaces, spacing as a share of a line, fonts that fall back alike', () => {
    // `pptxtojson` 2.2.0 writes every space unbreakable and 20% spacing as `20em`.
    const said = textContent('<p style="margin-top: 20em;margin-bottom: 4pt;"><span style="font-family: Calibri;">Sales&nbsp;grew&nbsp;&nbsp;fast</span></p><p><span style="font-family: Georgia;">Costs</span></p>')
    expect(said).toContain('Sales grew  fast')
    expect(said).toContain('margin-top: 0.2em')
    expect(said).toContain('margin-bottom: 4pt')
    expect(said).toContain("font-family: 'Calibri', Calibri, Carlito, 'Helvetica Neue', Arial, sans-serif")
    expect(said).toContain("font-family: 'Georgia', Georgia, 'Times New Roman', serif")
    // A bullet is the size and colour of its item's words.
    expect(textContent('<ul><li><p style="text-align: left;"><span style="color: #1F2A44;font-size: 19pt;">North</span></p></li></ul>'))
      .toBe('<ul><li style="font-size: 19pt;color: #1F2A44"><p style="text-align: left;"><span style="color: #1F2A44;font-size: 19pt;">North</span></p></li></ul>')
  })

  it('gives a straight line a point of room to be drawn in, with its arrowhead', () => {
    const line = { type: 'shape', id: '8', name: 'Connector 7', ...box, height: 0, borderColor: '#4B5563', borderWidth: 1.75, borderType: 'solid', borderStrokeDasharray: '0', fill: { type: 'color', value: '#4F81BD' }, content: '', vAlign: 'up', wrap: true, shapType: 'line', path: 'M 0 0 L 288 0', pathViewBox: { x: 0, y: 0, width: 288, height: 0 }, tailEnd: { type: 'triangle' } } as unknown as Element
    const page = drawn(deck([slide([line])]))
    const part = page.querySelector<HTMLElement>('.lw-el')!
    expect([part.style.top, part.style.height]).toEqual(['71.5pt', '1pt'])
    const svg = part.querySelector('svg')!
    expect(svg.getAttribute('viewBox')).toBe('0 -0.5 288 1')
    const path = svg.querySelector(':scope > path')!
    expect(path.getAttribute('fill')).toBe('none')
    expect(path.getAttribute('stroke')).toBe('#4B5563')
    expect(path.getAttribute('marker-end')).toBe('url(#lw-end-8-end)')
    expect(svg.querySelector('marker#lw-end-8-end')!.getAttribute('fill')).toBe('#4B5563')
  })

  it('gives a line straight down the same point of room, across', () => {
    const line = { type: 'shape', id: '9', name: 'Connector 8', ...box, width: 0, borderColor: '#4B5563', borderWidth: 1.75, borderType: 'solid', borderStrokeDasharray: '0', fill: { type: 'color', value: '' }, content: '', vAlign: 'up', wrap: true, shapType: 'line', path: 'M 0 0 L 0 108', pathViewBox: { x: 0, y: 0, width: 0, height: 108 } } as unknown as Element
    const part = drawn(deck([slide([line])])).querySelector<HTMLElement>('.lw-el')!
    expect([part.style.left, part.style.width, part.style.height]).toEqual(['35.5pt', '1pt', '108pt'])
    expect(part.querySelector('svg')!.getAttribute('viewBox')).toBe('-0.5 0 1 108')
  })

  it('names a clip by its slide, says how to play it, and draws its place where it can be seen', () => {
    const clip = { type: 'video', id: 'v', ...box, ref: 'ppt/media/clip.mp4', blob: '' } as unknown as Element
    const page = drawn(deck([slide([]), slide([clip])]))
    const place = page.querySelector('.lw-media')!
    expect([place.getAttribute('role'), place.getAttribute('aria-label'), place.getAttribute('title')]).toEqual(['img', 'Video on slide 2', 'Video. Open the file in its own app to play it.'])
  })

  it('lays the slides on the reader’s own ground, its words in the reader’s colours, and nothing there but colours', () => {
    const page = slidesPage(deck([slide([], { note: '<p>Hi</p>' }), slide([])]), 'deck.pptx', { ground: '#08080A', ink: '#F5F3EE', label: '#A9A59C', accent: '#E9C46A', accentDim: '#8C7130', paperAccent: '#8A6A16' })
    expect(page).toContain('html{background:#08080A}')
    expect(page).toContain('color:#F5F3EE')
    expect(page).toMatch(/\.lw-slide-number\{[^}]*color:#A9A59C/)
    expect(page).toMatch(/\.lw-thumb\[aria-current="true"\] \.lw-thumb-paper\{box-shadow:0 0 0 2px #E9C46A\}/)
    const odd = slidesPage(deck([slide([])]), 'deck.pptx', { ground: 'red;}</style><script>', ink: 'oklch(0.2 0.01 90)', label: '', accent: '', accentDim: '', paperAccent: '' })
    expect(odd).toContain('html{background:#FAF8F3}')
    expect(odd).toContain('color:oklch(0.2 0.01 90)')
    expect(odd).not.toContain('</style><script>')
  })

  it('draws a shape’s outline, filled with its gradient, its words over it', () => {
    const oval = { type: 'shape', id: '3', name: 'Oval 2', ...box, ...plain, borderColor: '#000000', borderWidth: 0.75, fill: { type: 'gradient', value: { rot: 45, path: 'line', colors: [{ pos: '0%', color: '#3e7fcd' }, { pos: '100%', color: '#86bdff' }] } }, content: '<p>Oval</p>', vAlign: 'mid', wrap: true, shapType: 'ellipse', path: 'M 0,54 A 144,54 0 1,0 288,54 A 144,54 0 1,0 0,54 Z', pathViewBox: { x: 0, y: 0, width: 288, height: 108 } } as unknown as Element
    const page = drawn(deck([slide([oval])]))
    expect(page.querySelector('path')!.getAttribute('fill')).toBe('url(#lw-fill-3-0)')
    expect(page.querySelector('linearGradient#lw-fill-3-0')!.getAttribute('gradientTransform')).toBe('rotate(45 0.5 0.5)')
    expect(page.querySelector('.lw-text.mid')!.textContent).toBe('Oval')
  })

  it('draws a picture from the deck’s own data only, the part a crop leaves', () => {
    const picture = (base64: string, rect?: Record<string, number>) => ({ type: 'image', id: 'p', ...box, ref: 'ppt/media/image1.png', base64, blob: '', geom: 'rect', borderColor: '', borderWidth: 0, borderType: 'solid', borderStrokeDasharray: '0', rect }) as unknown as Element
    const page = drawn(deck([slide([picture('data:image/png;base64,iVBORw0KGgo=', { l: 25, r: 25 }), picture('https://example.com/x.png'), picture('data:text/html;base64,PHNjcmlwdD4=')])]))
    const images = page.querySelectorAll('img')
    expect(images).toHaveLength(1)
    expect([images[0].style.left, images[0].style.width]).toEqual(['-50%', '200%'])
  })

  it('never puts anything but a colour where the deck gives one', () => {
    const page = slidesPage(deck([slide([words('<p>x</p>', { fill: { type: 'color', value: 'red;background:url(https://example.com/x)' }, borderColor: '#000;}</style><script>', borderWidth: 1 })])]), 'deck.pptx')
    expect(page).not.toContain('example.com')
    expect(page).not.toContain('</style><script>')
  })

  it('draws a table with its merged cells once and its cells’ own fills', () => {
    const cell = (text: string, extra: Record<string, unknown> = {}) => ({ text: `<p>${text}</p>`, vAlign: 'mid', borders: {}, ...extra })
    const table = { type: 'table', id: 'tb', ...box, borders: {}, rowHeights: [20, 20], colWidths: [100, 188], data: [
      [cell('Region', { fillColor: '#1F2A44', fontColor: '#FFFFFF', fontBold: true }), cell('Q1')],
      [cell('North', { rowSpan: 2 }), cell('4')],
      [cell('', { vMerge: 1 }), cell('5')],
    ] } as unknown as Element
    const page = drawn(deck([slide([table])]))
    const rows = [...page.querySelectorAll('tr')].map((row) => [...row.querySelectorAll('td')].map((td) => td.textContent))
    expect(rows).toEqual([['Region', 'Q1'], ['North', '4'], ['5']])
    const header = page.querySelector<HTMLElement>('td')!
    expect([header.style.background, header.style.color, header.style.fontWeight]).toEqual(['rgb(31, 42, 68)', 'rgb(255, 255, 255)', 'bold'])
    expect(page.querySelectorAll('td')[2].getAttribute('rowspan')).toBe('2')
  })

  it('draws a chart from the deck’s own numbers: a column for each, its categories and its series named', () => {
    const series = (key: string, ys: number[]) => ({ key, values: ys.map((y, x) => ({ x: String(x), y })), xlabels: { 0: 'Q1', 1: 'Q2' } })
    const chart = (chartType: string, data: unknown) => ({ type: 'chart', id: 'c', ...box, chartType, data, colors: [], barDir: 'col', grouping: 'clustered' }) as unknown as Element
    const bars = drawn(deck([slide([chart('barChart', [series('North', [4, 9]), series('South', [5, 6])])])]))
    const svg = bars.querySelector('svg.lw-chart')!
    expect(svg.closest('[role="img"]')!.getAttribute('aria-label')).toBe('Chart on slide 1')
    expect(svg.querySelectorAll('rect[height]:not([height="7"])')).toHaveLength(4)
    expect([...svg.querySelectorAll('text')].map((text) => text.textContent)).toEqual(expect.arrayContaining(['Q1', 'Q2', 'North', 'South', '9']))
    const pie = drawn(deck([slide([chart('pieChart', [{ ...series('Costs', [30, 70]), xlabels: { 0: 'Rent', 1: 'Staff' } }])])]))
    expect(pie.querySelectorAll('svg.lw-chart path')).toHaveLength(2)
    // A kind it doesn't draw is the table of its numbers.
    const radar = drawn(deck([slide([chart('radarChart', [series('North', [4, 9])])])]))
    expect([...radar.querySelectorAll('td')].map((td) => td.textContent)).toEqual(['', 'North', 'Q1', '4', 'Q2', '9'])
  })
})
