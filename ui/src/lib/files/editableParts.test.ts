import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { deckFile, paragraph, placeholder, table } from '../../test/officeFiles'
import { documentPage } from './documentPage'
import { drawnPage } from './drawnPage'
import { EDITING_ATTRIBUTE, wordsIn } from './editableParts'
import { PARAGRAPH_MARK } from './officeEdits'
import { WORD_WORDS, wordFile } from './officeEditFixtures'
import { PAPER_LOOK } from './pageLook'

const asPage = (html: string) => new DOMParser().parseFromString(html, 'text/html')
/** Each part offered to type into, by its name, with its words as the page reads them. */
const offered = (doc: Document) => [...doc.querySelectorAll('[data-lw-edit]')].map((part) => [part.getAttribute('data-lw-edit'), wordsIn(part)])

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

/** A box of words on a slide that isn't a placeholder, at a place of its own. */
const box = (id: number, paragraphs: string, y = 400) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Box ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="${y * 12700}"/><a:ext cx="3000000" cy="400000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
const group = (inside: string) => `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="6" name="Group 6"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="457200" y="5000000"/><a:ext cx="3000000" cy="400000"/><a:chOff x="457200" y="5000000"/><a:chExt cx="3000000" cy="400000"/></a:xfrm></p:grpSpPr>${inside}</p:grpSp>`
const BROKEN = '<a:p><a:r><a:rPr lang="en-US"/><a:t>North led</a:t></a:r><a:br><a:rPr lang="en-US"/></a:br><a:r><a:rPr lang="en-US"/><a:t>South held</a:t></a:r></a:p>'

/**
 * A deck of two slides: the first with a title, a body of two paragraphs (one with a line break), a
 * table, a box in a group and two paragraphs of notes; the second with a title and no notes.
 */
async function deckWithNotes(): Promise<ArrayBuffer> {
  const bytes = await deckFile({
    slides: [
      placeholder(3, 'title', null, paragraph('What we found')) + placeholder(4, 'body', '1', paragraph('Sales grew') + BROKEN)
        + table([['Region', 'Q1'], ['North', '4']], '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}') + group(box(7, paragraph('In a group'))),
      placeholder(3, 'title', null, paragraph('Thanks')),
    ],
  })
  const zip = await JSZip.loadAsync(bytes)
  zip.file('ppt/slides/_rels/slide1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`)
  zip.file('ppt/notesSlides/notesSlide1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>`
    + '<a:p><a:r><a:rPr lang="en-US"/><a:t>Start with the 92% & why.</a:t></a:r></a:p><a:p><a:r><a:rPr lang="en-US"/><a:t>It rose</a:t></a:r><a:br/><a:r><a:rPr lang="en-US"/><a:t>since spring.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>'.replace('&', '&amp;'))
  return zip.generateAsync({ type: 'arraybuffer' })
}

const answered = (bytes: ArrayBuffer | Uint8Array, version = 'sha256:abc') => vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes.slice(0), { status: 200, headers: { ETag: `"${version}"` } })))

describe('a deck drawn to be typed into (ADR 0107)', () => {
  it('offers each paragraph of each box of words by its box’s id, and each paragraph of the notes, the words as the file has them', async () => {
    const file = await deckWithNotes()
    answered(file)
    const drawn = await drawnPage('/w/deck.pptx', 'slides', 'deck.pptx', '1', { editing: true })
    const doc = asPage(drawn.html)
    expect(doc.documentElement.hasAttribute(EDITING_ATTRIBUTE)).toBe(true)
    expect(offered(doc)).toEqual([
      ['shape:0:3:0', 'What we found'],
      ['shape:0:4:0', 'Sales grew'],
      // Drawn by pptxtojson as a space, the line break is drawn again from the file, as a break.
      ['shape:0:4:1', 'North led\nSouth held'],
      ['shape:0:7:0', 'In a group'],
      ['note:0:0', 'Start with the 92% & why.'],
      ['note:0:1', 'It rose\nsince spring.'],
      ['shape:1:3:0', 'Thanks'],
    ])
    for (const part of doc.querySelectorAll('[data-lw-edit]')) expect(part.getAttribute('contenteditable')).toBe('true')
    // The notes take line breaks; a slide's boxes don't.
    expect([...doc.querySelectorAll('[data-lw-lines]')].map((part) => part.getAttribute('data-lw-edit'))).toEqual(['note:0:0', 'note:0:1'])
    // The broken paragraph keeps the look of its first words.
    const broken = doc.querySelector('[data-lw-edit="shape:0:4:1"]')!
    expect(broken.querySelector('span')!.getAttribute('style')).toContain('font-size')
    // A table is drawn as it is, and the notes as paragraphs rather than steps; a slide with none shows none.
    expect(doc.querySelectorAll('td[contenteditable], td [contenteditable]')).toHaveLength(0)
    const [first, second] = doc.querySelectorAll('section.lw-slide')
    expect(first.querySelectorAll('.lw-step')).toHaveLength(0)
    expect(first.querySelector('.lw-notes-label')!.textContent).toBe('Notes, slide 1')
    expect(second.querySelector('.lw-note')).toBeNull()
    // The bytes drawn, and their version, are handed back for a change to be made on.
    expect(drawn.version).toBe('sha256:abc')
    expect(drawn.bytes).toEqual(new Uint8Array(file))
  })

  it('draws a deck as before when not typed into: no part offered, its notes walked as steps', async () => {
    answered(await deckWithNotes())
    const { html } = await drawnPage('/w/deck.pptx', 'slides', 'deck.pptx', '1')
    const doc = asPage(html)
    expect(doc.documentElement.hasAttribute(EDITING_ATTRIBUTE)).toBe(false)
    expect(doc.querySelectorAll('[data-lw-edit], [contenteditable], .lw-note')).toHaveLength(0)
    const steps = [...doc.querySelectorAll('.lw-step')].map((step) => step.textContent ?? '')
    expect(steps).toHaveLength(2)
    expect(steps[0]).toContain('Start with the 92%')
  })
})

describe('a Word document drawn to be typed into (ADR 0107)', () => {
  it('offers each paragraph of its body by its number — headings, lists, table cells — and none of its header, links or a paragraph a page break cuts', async () => {
    const page = await documentPage(await wordFile(), 'plan.docx', PAPER_LOOK, { editing: true })
    const doc = asPage(page)
    expect(doc.documentElement.hasAttribute(EDITING_ATTRIBUTE)).toBe(true)
    const expected = WORD_WORDS.flatMap((words, index) => (words === null ? [] : [[`para:${index}`, words]]))
    expect(offered(doc)).toEqual(expected)
    // Each where it is drawn: the heading as a heading, the list's items, the table's cells.
    const at = (index: number) => doc.querySelector(`[data-lw-edit="para:${index}"]`)!
    expect(at(0).className).toContain('heading1')
    expect(at(2).className).toMatch(/num/)
    expect(at(4).closest('td')).not.toBeNull()
    expect(at(5).closest('td')).not.toBeNull()
    // The header is drawn, and not offered.
    const header = doc.querySelector('header')
    expect(header?.textContent).toContain('Tea Co.')
    expect(header!.querySelector('[data-lw-edit]')).toBeNull()
    // A tab is kept whole, as a tab.
    expect(at(3).querySelectorAll('[data-lw-tab][contenteditable="false"]')).toHaveLength(1)
    // The marks it was found by are gone.
    expect(page).not.toContain(PARAGRAPH_MARK)
    // An empty paragraph keeps a line's room.
    expect(at(8).classList.contains('lw-blank')).toBe(true)
  })

  it('draws a Word document as before when not typed into', async () => {
    const page = await documentPage(await wordFile(), 'plan.docx', PAPER_LOOK)
    const doc = asPage(page)
    expect(doc.documentElement.hasAttribute(EDITING_ATTRIBUTE)).toBe(false)
    expect(doc.querySelectorAll('[data-lw-edit], [contenteditable], [data-lw-tab]')).toHaveLength(0)
    expect(doc.querySelector('section.docx')!.textContent).toContain('We sell tea and cake.')
  })
})

describe('the words of a part typed into', () => {
  it('reads line breaks as new lines and tabs as tabs, leaving out the reader’s bubbles and the line break a browser ends a part on', () => {
    const part = document.createElement('p')
    part.innerHTML = 'Price:<span data-lw-tab="" contenteditable="false"> </span>£4<br>each<span class="lw-slot"><button>×</button></span>'
    expect(wordsIn(part)).toBe('Price:\t£4\neach')
    part.innerHTML = 'Ends here<br><br>'
    expect(wordsIn(part)).toBe('Ends here\n')
    part.innerHTML = '<br>'
    expect(wordsIn(part)).toBe('')
    part.innerHTML = 'a<br>b'
    expect(wordsIn(part)).toBe('a\nb')
  })
})
