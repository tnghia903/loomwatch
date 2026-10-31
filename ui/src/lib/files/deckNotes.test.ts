import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import { deckNotes, withNote } from './deckNotes'

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const notesSlide = (paragraphs: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes ${NS}><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>
</p:spTree></p:cSld></p:notes>`

const rels = (target: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="${REL}/notesSlide" Target="${target}"/>
</Relationships>`

/** A deck of three slides, numbered 1, 2 and 10: the first has no notes. */
async function deck(): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const n of [1, 2, 10]) zip.file(`ppt/slides/slide${n}.xml`, `<p:sld ${NS}/>`)
  zip.file('ppt/slides/_rels/slide2.xml.rels', rels('../notesSlides/notesSlide1.xml'))
  zip.file('ppt/slides/_rels/slide10.xml.rels', rels('../notesSlides/notesSlide2.xml'))
  zip.file('ppt/notesSlides/notesSlide1.xml', notesSlide(
    '<a:p><a:pPr marL="0"/><a:r><a:rPr lang="en-GB" b="1"/><a:t>Start with </a:t></a:r><a:r><a:rPr lang="en-GB"/><a:t>the 92%.</a:t></a:r><a:endParaRPr lang="en-GB"/></a:p>'
    + '<a:p><a:r><a:rPr lang="en-GB"/><a:t>It rose 9 points</a:t></a:r><a:br><a:rPr lang="en-GB"/></a:br><a:r><a:rPr lang="en-GB"/><a:t>since spring.</a:t></a:r></a:p>'))
  zip.file('ppt/notesSlides/notesSlide2.xml', notesSlide('<a:p><a:r><a:rPr lang="en-GB"/><a:t>Thank everyone.</a:t></a:r></a:p>'))
  zip.file('ppt/presentation.xml', `<p:presentation ${NS}/>`)
  return zip.generateAsync({ type: 'uint8array' })
}

describe('a deck’s speaker notes, changed in their own part of the file (ADR 0107)', () => {
  it('reads each slide’s notes paragraphs in the order the slides are drawn', async () => {
    expect(await deckNotes(await deck())).toEqual([
      null,
      ['Start with the 92%.', 'It rose 9 points\nsince spring.'],
      ['Thank everyone.'],
    ])
  })

  it('writes a changed paragraph back into its own place, keeping its settings and its first words’ formatting', async () => {
    const changed = await withNote(await deck(), 1, 1, 'It rose 9 points\nsince April.')
    if (!changed) throw new Error('nothing changed')
    expect(await deckNotes(changed)).toEqual([
      null,
      ['Start with the 92%.', 'It rose 9 points\nsince April.'],
      ['Thank everyone.'],
    ])
    const zip = await JSZip.loadAsync(changed)
    const xml = await zip.file('ppt/notesSlides/notesSlide1.xml')?.async('string')
    expect(xml?.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')).toBe(true)
    // The first paragraph, and the slide image placeholder, are as they were.
    expect(xml).toContain('<a:pPr marL="0"/><a:r><a:rPr lang="en-GB" b="1"/><a:t>Start with </a:t></a:r>')
    expect(xml).toContain('<p:ph type="sldImg"/>')
    // The other parts of the deck are untouched.
    expect(await zip.file('ppt/notesSlides/notesSlide2.xml')?.async('string')).toBe(notesSlide('<a:p><a:r><a:rPr lang="en-GB"/><a:t>Thank everyone.</a:t></a:r></a:p>'))
  })

  it('keeps the paragraph’s end, and the formatting of its first words, when it is said again in one run', async () => {
    const changed = await withNote(await deck(), 1, 0, 'Open with the 92%.')
    if (!changed) throw new Error('nothing changed')
    const xml = await (await JSZip.loadAsync(changed)).file('ppt/notesSlides/notesSlide1.xml')?.async('string')
    expect(xml).toContain('<a:p><a:pPr marL="0"/><a:r><a:rPr lang="en-GB" b="1"/><a:t>Open with the 92%.</a:t></a:r><a:endParaRPr lang="en-GB"/></a:p>')
  })

  it('changes nothing for the same words, a slide with no notes, or a paragraph it does not have', async () => {
    const bytes = await deck()
    expect(await withNote(bytes, 1, 0, 'Start with the 92%.')).toBeNull()
    expect(await withNote(bytes, 0, 0, 'Hello')).toBeNull()
    expect(await withNote(bytes, 2, 5, 'Hello')).toBeNull()
    expect(await withNote(bytes, 7, 0, 'Hello')).toBeNull()
  })
})
