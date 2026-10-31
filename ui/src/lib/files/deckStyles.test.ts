import { describe, expect, it } from 'vitest'

import { deckFile, paragraph, placeholder, slideXml, table } from '../../test/officeFiles'
import { tint, withInheritedStyles } from './deckStyles'

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
/** Each paragraph's words and the bullet it says it has, in order. */
const bullets = (slide: Document) => Array.from(slide.getElementsByTagNameNS(A, 'p')).map((p) => {
  const bullet = p.getElementsByTagNameNS(A, 'buChar')[0] ?? p.getElementsByTagNameNS(A, 'buAutoNum')[0] ?? p.getElementsByTagNameNS(A, 'buNone')[0]
  return [p.textContent, bullet ? bullet.getAttribute('char') ?? bullet.localName : null]
})
const DEFAULT_STYLE = '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}'

describe('a deck with what its slides take from their master written onto them', () => {
  it('gives a placeholder’s paragraphs the bullets of their level, from its layout or its master', async () => {
    const deck = await deckFile({
      // The layout numbers its second placeholder's first level instead.
      layout: placeholder(2, 'body', '1', '') + placeholder(3, 'body', '2', '', '<a:lvl1pPr><a:buAutoNum type="arabicPeriod"/></a:lvl1pPr>'),
      slides: [
        placeholder(4, 'title', null, paragraph('What we found'))
        + placeholder(5, null, '1', paragraph('Sales grew') + paragraph('North led', 1) + paragraph('') + paragraph('Said its own', 0, '<a:buNone/>'))
        + placeholder(6, 'body', '2', paragraph('First step'))
        + '<p:sp><p:nvSpPr><p:cNvPr id="7" name="TextBox 7"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>' + paragraph('A note') + '</p:txBody></p:sp>',
      ],
    })
    const slide = await slideXml(await withInheritedStyles(deck))
    expect(bullets(slide)).toEqual([
      // A title has none, the master says.
      ['What we found', null],
      ['Sales grew', '•'],
      ['North led', '–'],
      // An empty line has none to show; a paragraph that says it has none keeps none.
      ['', null],
      ['Said its own', 'buNone'],
      ['First step', 'buAutoNum'],
      // A text box is not a placeholder: it takes nothing from the master's body text.
      ['A note', null],
    ])
  })

  it('writes PowerPoint’s own table style onto a table that names it: the header in the accent, the rows in its tints', async () => {
    const deck = await deckFile({ accent: '4F81BD', slides: [table([['Region', 'Q1'], ['North', '4'], ['South', '5'], ['West', '6']], DEFAULT_STYLE)] })
    const slide = await slideXml(await withInheritedStyles(deck))
    const rows = Array.from(slide.getElementsByTagNameNS(A, 'tr')).map((row) => Array.from(row.getElementsByTagNameNS(A, 'tc')).map((cell) => cell.getElementsByTagNameNS(A, 'tcPr')[0].getElementsByTagNameNS(A, 'srgbClr')[0]?.getAttribute('val')))
    expect(rows).toEqual([['4F81BD', '4F81BD'], ['D0D8E8', 'D0D8E8'], ['E9EDF4', 'E9EDF4'], ['D0D8E8', 'D0D8E8']])
    const header = slide.getElementsByTagNameNS(A, 'tr')[0].getElementsByTagNameNS(A, 'rPr')[0]
    expect(header.getAttribute('b')).toBe('1')
    expect(header.getElementsByTagNameNS(A, 'srgbClr')[0].getAttribute('val')).toBe('FFFFFF')
    expect(slide.getElementsByTagNameNS(A, 'tr')[1].getElementsByTagNameNS(A, 'rPr')[0].hasAttribute('b')).toBe(false)
  })

  it('keeps the fills a table gives its own cells, and leaves a table alone whose style the deck carries itself, or that names another', async () => {
    const own = await deckFile({ slides: [table([['Region'], ['North']], DEFAULT_STYLE, '<a:solidFill><a:srgbClr val="1F2A44"/></a:solidFill>')] })
    const fills = Array.from((await slideXml(await withInheritedStyles(own))).getElementsByTagNameNS(A, 'tcPr')).map((props) => Array.from(props.getElementsByTagNameNS(A, 'srgbClr')).map((colour) => colour.getAttribute('val')))
    expect(fills).toEqual([['1F2A44'], ['1F2A44']])
    const carried = await deckFile({ slides: [table([['Region'], ['North']], DEFAULT_STYLE)], tableStyles: `<a:tblStyleLst xmlns:a="${A}" def="${DEFAULT_STYLE}"><a:tblStyle styleId="${DEFAULT_STYLE}" styleName="Medium Style 2 - Accent 1"/></a:tblStyleLst>` })
    expect(await withInheritedStyles(carried)).toBe(carried)
    const other = await deckFile({ slides: [table([['Region'], ['North']], '{2D5ABB26-0587-4C30-8999-92F81FD0307C}')] })
    expect(await withInheritedStyles(other)).toBe(other)
  })

  it('tints a colour as Office does, in linear light', () => {
    expect(tint('4F81BD', 0.4)).toBe('D0D8E8')
    expect(tint('4F81BD', 0.2)).toBe('E9EDF4')
    expect(tint('000000', 0)).toBe('FFFFFF')
    expect(tint('123456', 1)).toBe('123456')
  })
})
