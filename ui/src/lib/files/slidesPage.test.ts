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

describe('a slide deck drawn as a page', () => {
  it('draws each slide at its own size, under its number, scaled to the page, with its notes open under it', () => {
    const page = drawn(deck([slide([words('<p>One</p>')], { note: '<p>Say hello.</p>' }), slide([words('<p>Two</p>')])]), 'Q3 <review>.pptx')
    expect(page.title).toBe('Q3 <review>.pptx')
    expect([...page.querySelectorAll('h2')].map((heading) => heading.textContent)).toEqual(['Slide 1', 'Slide 2'])
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
    expect(notes.querySelector('.lw-notes-words')!.textContent).toBe('Say hello.')
    expect(page.querySelectorAll('section')[1].querySelector('.lw-notes')).toBeNull()
  })

  it('draws a strip of every slide beside them, a button for each, and none for a deck of one slide', () => {
    const page = drawn(deck([slide([words('<p>One</p>')]), slide([words('<p>Two</p>')]), slide([])]))
    const strip = page.querySelector('nav.lw-strip')!
    expect(strip.getAttribute('aria-label')).toBe('Slides')
    expect([...strip.querySelectorAll('button')].map((thumb) => thumb.getAttribute('aria-label'))).toEqual(['Slide 1', 'Slide 2', 'Slide 3'])
    expect(strip.querySelector('.lw-thumb-paper')!.getAttribute('style')).toBe('aspect-ratio:960/540')
    // Its copies of the slides are drawn in by the page's script, inert, and it follows the slide in view.
    const script = page.querySelector('script')!.textContent!
    expect(script).toContain("copy.setAttribute('inert','')")
    expect(script).toContain("t.setAttribute('aria-current','true')")
    expect(script).toContain('scrollIntoView')
    // The frame takes its size after the page loads: the slide in view is found again on a resize.
    expect(script).toContain("addEventListener('resize',function(){draw();follow();})")
    const single = drawn(deck([slide([])]))
    expect(single.querySelector('.lw-strip')).toBeNull()
    expect(single.querySelector('.lw-reader')!.classList.contains('single')).toBe(true)
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
    expect(first.querySelector('h2')!.textContent).toBe('Slide 1')
    expect([...first.querySelectorAll('.lw-canvas > .lw-el')].map((part) => part.classList.contains('lw-changed'))).toEqual([false, true])
    const notes = page.querySelectorAll('section')[1].querySelector('.lw-notes')!
    expect(notes.querySelector('h3 .lw-change-mark')).not.toBeNull()
    expect(notes.querySelector('h3')!.textContent).toBe('Notes, slide 2')
    expect(page.querySelectorAll('section')[2].querySelector('.lw-change-mark')).toBeNull()
    expect(thumbs[0].getAttribute('title')).toBe('Changed since you last looked')
    // The page opens at the first slide that changed; the stitch is the change's mark, a dashed outline Pick's.
    expect(page.querySelectorAll('section')[0].classList.contains('changed')).toBe(true)
    const html = slidesPage(after, 'deck.pptx', undefined, { changes: deckChanges(deckSeen(before), deckSeen(after)), face })
    expect(html).toContain("document.querySelector('.lw-slide.changed')")
    expect(html).not.toMatch(/\.lw-changed\{outline/)
    // A face that isn't a picture's data is never put in the page.
    const odd = drawn(after, 'deck.pptx', { changes: deckChanges(deckSeen(before), deckSeen(after)), face: 'https://example.com/face.png' })
    expect(odd.querySelector('img')).toBeNull()
  })

  it('names nothing in the page as the reader’s own marks in it do, so their styles never reach the slides', () => {
    const before = deck([slide([words('<p>A</p>')], { note: '<p>n</p>' }), slide([], { fill: { type: 'color', value: '#111111' } })])
    const after = deck([slide([words('<p>B</p>')], { note: '<p>m</p>' }), slide([words('<p>C</p>')], { fill: { type: 'color', value: '#111111' } })])
    const page = drawn(after, 'deck.pptx', { changes: deckChanges(deckSeen(before), deckSeen(after)), face: 'data:image/webp;base64,UklGRg==' })
    const ours = new Set([...page.querySelectorAll('[class]')].flatMap((element) => [...element.classList]).filter((name) => name.startsWith('lw-')))
    const theirs = new Set(PAGE_BRIDGE.match(/\.lw-[a-z-]+/g)!.map((name) => name.slice(1)))
    expect(ours.size).toBeGreaterThan(10)
    expect([...ours].filter((name) => theirs.has(name))).toEqual([])
  })

  it('draws a change on a dark slide in bright gold, on a light one in the paper’s gold', () => {
    const dark = drawn(deck([slide([words('<p>x</p>')], { fill: { type: 'color', value: '#1F2937' } }), slide([words('<p>y</p>')])]))
    expect([...dark.querySelectorAll('.lw-canvas')].map((canvas) => canvas.classList.contains('lw-dark-slide'))).toEqual([true, false])
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
    const page = slidesPage(deck([slide([], { note: '<p>Hi</p>' }), slide([])]), 'deck.pptx', { ground: '#08080A', ink: '#F5F3EE', label: '#A9A59C', accent: '#E9C46A', paperAccent: '#8A6A16' })
    expect(page).toContain('html{background:#08080A}')
    expect(page).toContain('color:#F5F3EE')
    expect(page).toMatch(/\.lw-slide-number\{[^}]*color:#A9A59C/)
    expect(page).toMatch(/\.lw-thumb\[aria-current="true"\] \.lw-thumb-paper\{box-shadow:0 0 0 2px #E9C46A\}/)
    const odd = slidesPage(deck([slide([])]), 'deck.pptx', { ground: 'red;}</style><script>', ink: 'oklch(0.2 0.01 90)', label: '', accent: '', paperAccent: '' })
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
