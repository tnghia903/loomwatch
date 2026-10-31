import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import { deckNotes } from './deckNotes'
import { deckEdit, deckShapes, documentEdit, documentParagraphs, editPart, officeEdit, PARAGRAPH_MARK, withParagraphMarks } from './officeEdits'
import { WORD_BODY, WORD_WORDS, wordFile } from './officeEditFixtures'

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const shape = (id: number, paragraphs: string) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Box ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
const slideXml = (shapes: string) => `${DECLARATION}<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld></p:sld>`
const FIRST = '<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-GB" b="1"/><a:t>Sales grew </a:t></a:r><a:r><a:rPr lang="en-GB"/><a:t>12%</a:t></a:r><a:endParaRPr lang="en-GB"/></a:p>'
const SECOND = '<a:p><a:r><a:rPr lang="en-GB"/><a:t>North led</a:t></a:r><a:br><a:rPr lang="en-GB"/></a:br><a:r><a:rPr lang="en-GB"/><a:t>South held</a:t></a:r></a:p>'
const LINKED = '<a:p><a:r><a:rPr lang="en-GB"><a:hlinkClick r:id="rId9"/></a:rPr><a:t>Read more</a:t></a:r></a:p>'
const FIELD = '<a:p><a:fld id="{1}" type="slidenum"><a:rPr lang="en-GB"/><a:t>2</a:t></a:fld></a:p>'

/**
 * A deck of two slides, listed as slides 1 and 10 (and a slide file it doesn't list): the first with a
 * title, a body of two paragraphs, a link, a slide number, a group with a box in it, and two boxes
 * that share an id; the second with a title.
 */
async function deck(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `${DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/slides/slide10.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`)
  zip.file('ppt/slides/slide1.xml', slideXml(
    shape(2, '<a:p><a:r><a:rPr lang="en-GB"/><a:t>Plan</a:t></a:r></a:p>')
    + shape(3, FIRST + SECOND)
    + shape(4, LINKED + FIELD)
    + `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="5" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shape(6, '<a:p><a:r><a:rPr lang="en-GB" i="1"/><a:t>In a group</a:t></a:r></a:p>')}</p:grpSp>`
    + shape(7, '<a:p><a:r><a:t>One</a:t></a:r></a:p>') + shape(7, '<a:p><a:r><a:t>Other</a:t></a:r></a:p>')))
  zip.file('ppt/slides/slide10.xml', slideXml(shape(2, '<a:p><a:r><a:rPr lang="en-GB"/><a:t>Thanks</a:t></a:r></a:p>')))
  zip.file('ppt/slides/slide3.xml', slideXml(shape(2, '<a:p><a:r><a:t>Not listed</a:t></a:r></a:p>')))
  return zip.generateAsync({ type: 'uint8array' })
}

const partOf = async (bytes: Uint8Array, path: string) => (await JSZip.loadAsync(bytes)).file(path)!.async('string')

describe('the words of a deck’s boxes, changed where they are drawn (ADR 0107)', () => {
  it('reads each box’s paragraphs by its id, in the order the deck lists its slides; a link, a field and a shared id are not offered', async () => {
    const shapes = await deckShapes(await deck())
    expect(shapes).toHaveLength(2)
    expect(Object.fromEntries(shapes[0])).toEqual({
      2: ['Plan'],
      3: ['Sales grew 12%', 'North led\nSouth held'],
      4: [null, null],
      6: ['In a group'],
    })
    expect(Object.fromEntries(shapes[1])).toEqual({ 2: ['Thanks'] })
  })

  it('writes a changed paragraph back into its box, keeping its settings, its end and its first words’ look, a line for each run', async () => {
    const bytes = await deck()
    const changed = await deckEdit(bytes, 'shape:0:3:0', 'Sales grew 14%\nin Q3')
    if (!changed) throw new Error('nothing changed')
    const xml = await partOf(changed, 'ppt/slides/slide1.xml')
    expect(xml.startsWith(DECLARATION)).toBe(true)
    expect(xml).toContain('<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-GB" b="1"/><a:t>Sales grew 14%</a:t></a:r><a:br/><a:r><a:rPr lang="en-GB" b="1"/><a:t>in Q3</a:t></a:r><a:endParaRPr lang="en-GB"/></a:p>')
    // The box's other paragraph, the other boxes and the other slide are as they were.
    expect(xml).toContain(SECOND)
    expect(xml).toContain(LINKED + FIELD)
    expect(await partOf(changed, 'ppt/slides/slide10.xml')).toBe(await partOf(bytes, 'ppt/slides/slide10.xml'))
    expect(Object.fromEntries((await deckShapes(changed))[0])[3]).toEqual(['Sales grew 14%\nin Q3', 'North led\nSouth held'])
  })

  it('finds a box inside a group, and a slide by the deck’s own order', async () => {
    const bytes = await deck()
    const grouped = await deckEdit(bytes, 'shape:0:6:0', 'Still in a group')
    expect(await partOf(grouped!, 'ppt/slides/slide1.xml')).toContain('<a:r><a:rPr lang="en-GB" i="1"/><a:t>Still in a group</a:t></a:r>')
    const last = await deckEdit(bytes, 'shape:1:2:0', 'Thank you')
    expect(await partOf(last!, 'ppt/slides/slide10.xml')).toContain('<a:t>Thank you</a:t>')
    expect(await partOf(last!, 'ppt/slides/slide1.xml')).toBe(await partOf(bytes, 'ppt/slides/slide1.xml'))
  })

  it('changes nothing for the same words, a box or paragraph it doesn’t have, a link, a field or a shared id', async () => {
    const bytes = await deck()
    expect(await deckEdit(bytes, 'shape:0:3:0', 'Sales grew 12%')).toBeNull()
    // The no-break spaces a browser types are spaces.
    expect(await deckEdit(bytes, 'shape:0:3:0', 'Sales grew 12%')).toBeNull()
    for (const part of ['shape:0:3:2', 'shape:0:99:0', 'shape:5:2:0', 'shape:0:4:0', 'shape:0:4:1', 'shape:0:7:0', 'para:0', 'shape:0:3', 'nonsense']) {
      expect(await deckEdit(bytes, part, 'Hello')).toBeNull()
    }
  })

  it('keeps the no-break spaces of words that had them, as a deck writes "12\u00a0%"', async () => {
    const zip = await JSZip.loadAsync(await deck())
    zip.file('ppt/slides/slide1.xml', slideXml(shape(8, '<a:p><a:r><a:rPr lang="en-GB"/><a:t>Up 12\u00a0%</a:t></a:r></a:p>')))
    const bytes = await zip.generateAsync({ type: 'uint8array' })
    expect(await deckEdit(bytes, 'shape:0:8:0', 'Up 12\u00a0%')).toBeNull()
    const changed = await deckEdit(bytes, 'shape:0:8:0', 'Up 13\u00a0%')
    expect(await partOf(changed!, 'ppt/slides/slide1.xml')).toContain('<a:t>Up 13\u00a0%</a:t>')
  })

  it('writes a note through its own part of the file', async () => {
    const zip = await JSZip.loadAsync(await deck())
    zip.file('ppt/slides/_rels/slide1.xml.rels', `${DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`)
    zip.file('ppt/notesSlides/notesSlide1.xml', `${DECLARATION}<p:notes ${NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-GB"/><a:t>Say it slowly.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`)
    const bytes = await zip.generateAsync({ type: 'uint8array' })
    // The notes of the slides the deck lists, in its order: the slide it doesn't list has none drawn.
    expect(await deckNotes(bytes)).toEqual([['Say it slowly.'], null])
    const changed = await officeEdit('slides', bytes, 'note:0:0', 'Say it slowly, twice.')
    expect(await deckNotes(changed!)).toEqual([['Say it slowly, twice.'], null])
  })

  it('reads a part’s name strictly', () => {
    expect(editPart('note:2:0')).toEqual({ kind: 'note', slide: 2, paragraph: 0 })
    expect(editPart('shape:0:12:3')).toEqual({ kind: 'shape', slide: 0, shape: '12', paragraph: 3 })
    expect(editPart('para:41')).toEqual({ kind: 'para', paragraph: 41 })
    for (const bad of ['note:1', 'note:1:2:3', 'para:', 'para:1:2', 'shape:1:2', 'para:-1', ' para:1', 'para:1x']) expect(editPart(bad)).toBeNull()
  })
})

describe('the words of a Word document’s paragraphs, changed where they are drawn (ADR 0107)', () => {
  it('numbers every paragraph of the body as it reads, those in a table among them, and offers only those that are words alone', async () => {
    // A text box's paragraph belongs to its drawing, and the header to a part of its own: neither is one of them.
    expect(await documentParagraphs(await wordFile())).toEqual(WORD_WORDS)
  })

  it('writes a changed paragraph back in the look of its first words, keeping its settings and its bookmarks round it', async () => {
    const bytes = await wordFile()
    const heading = await documentEdit(bytes, 'para:0', 'Our new plan')
    const xml = await partOf(heading!, 'word/document.xml')
    expect(xml.startsWith(DECLARATION)).toBe(true)
    expect(xml).toContain('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="0" w:name="_Toc1"/><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Our new plan</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>')
    // Its other paragraphs, and the document's other parts, are as they were.
    expect(xml).toContain(WORD_BODY.slice(WORD_BODY.indexOf('<w:p><w:proofErr')))
    expect(await partOf(heading!, 'word/header1.xml')).toBe(await partOf(bytes, 'word/header1.xml'))
    expect(await partOf(heading!, 'word/styles.xml')).toBe(await partOf(bytes, 'word/styles.xml'))
  })

  it('writes tabs as tabs and new lines as line breaks, in one run; spelling marks go with the words they marked', async () => {
    const bytes = await wordFile()
    const two = await documentEdit(bytes, 'para:1', 'We sell tea\tand cake\nevery day.')
    expect(await partOf(two!, 'word/document.xml')).toContain('<w:p><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">We sell tea</w:t><w:tab/><w:t xml:space="preserve">and cake</w:t><w:br/><w:t xml:space="preserve">every day.</w:t></w:r></w:p>')
    expect((await documentParagraphs(two!))[1]).toBe('We sell tea\tand cake\nevery day.')
    // In a table cell, and into the empty paragraph, which takes the words with no look of its own.
    const cell = await documentEdit(bytes, 'para:5', 'Q4')
    expect(await partOf(cell!, 'word/document.xml')).toContain('<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr><w:p><w:r><w:t xml:space="preserve">Q4</w:t></w:r></w:p></w:tc>')
    const empty = await documentEdit(bytes, 'para:8', 'Now with words')
    expect((await documentParagraphs(empty!))[8]).toBe('Now with words')
    // Emptied, a paragraph keeps its settings and has no runs.
    const emptied = await documentEdit(bytes, 'para:2', '')
    expect(await partOf(emptied!, 'word/document.xml')).toContain('<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr></w:p>')
  })

  it('changes nothing for the same words, a paragraph it doesn’t have, or one that is more than words', async () => {
    const bytes = await wordFile()
    expect(await documentEdit(bytes, 'para:3', 'Price:\t£4')).toBeNull()
    expect(await documentEdit(bytes, 'para:1', 'We sell tea and cake.')).toBeNull()
    for (const part of ['para:6', 'para:9', 'para:10', 'para:12', 'note:0:0', 'shape:0:2:0']) expect(await documentEdit(bytes, part, 'Hello')).toBeNull()
  })

  it('draws from a copy with a mark at the start of each paragraph that can be typed into, and writes nothing of it', async () => {
    const bytes = await wordFile()
    const { bytes: marked, words } = await withParagraphMarks(bytes)
    expect(words).toEqual(WORD_WORDS)
    const xml = await partOf(marked, 'word/document.xml')
    const marks = [...xml.matchAll(new RegExp(`w:name="${PARAGRAPH_MARK}(\\d+)"`, 'g'))].map((match) => Number(match[1]))
    expect(marks).toEqual([0, 1, 2, 3, 4, 5, 7, 8, 11])
    expect(xml).toContain(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="900000000" w:name="${PARAGRAPH_MARK}0"/><w:bookmarkStart w:id="0" w:name="_Toc1"/>`)
    expect(await partOf(bytes, 'word/document.xml')).not.toContain(PARAGRAPH_MARK)
  })
})
