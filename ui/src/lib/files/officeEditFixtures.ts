import JSZip from 'jszip'

/**
 * Small Word documents for the tests of changing one where it is drawn (ADR 0107): built here, so a
 * test says what is in the file it changes.
 */

const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
const run = (words: string, look = '') => `<w:r>${look ? `<w:rPr>${look}</w:rPr>` : ''}<w:t xml:space="preserve">${words}</w:t></w:r>`
const cell = (inside: string) => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${inside}</w:tc>`

/** The paragraphs of the Word document below, by their number, and what each is. */
export const WORD_BODY = [
  `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="0" w:name="_Toc1"/>${run('Our plan', '<w:b/>')}<w:bookmarkEnd w:id="0"/></w:p>`,
  `<w:p><w:proofErr w:type="spellStart"/>${run('We sell tea', '<w:i/>')}<w:proofErr w:type="spellEnd"/>${run(' and cake.')}</w:p>`,
  `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${run('Green tea')}</w:p>`,
  `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${run('Price:')}<w:r><w:tab/><w:t>£4</w:t></w:r></w:p>`,
  `<w:tbl><w:tblPr><w:tblW w:w="4800" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid><w:tr>${cell(`<w:p>${run('Region')}</w:p>`)}${cell(`<w:p>${run('Q3')}</w:p>`)}</w:tr></w:tbl>`,
  `<w:p><w:hyperlink r:id="rId9">${run('Our site')}</w:hyperlink></w:p>`,
  `<w:p>${run('First line')}<w:r><w:br/><w:t>second line</w:t></w:r></w:p>`,
  '<w:p/>',
  `<w:p>${run('Before the break')}<w:r><w:br w:type="page"/></w:r>${run('after it')}</w:p>`,
  `<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><wps:wsp><wps:txbx><w:txbxContent><w:p>${run('In a text box')}</w:p></w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>${run('Beside a box')}</w:p>`,
  `<w:p>${run('The end.')}</w:p>`,
].join('')

/**
 * A Word document with a heading, a paragraph of two looks, a list, a table, a link, a line break,
 * an empty paragraph, a page break inside a paragraph, a text box, and a header.
 */
export async function wordFile(body = WORD_BODY): Promise<Uint8Array> {
  const zip = new JSZip()
  const rels = (items: Array<[string, string, string]>) => `${DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"${type === 'hyperlink' ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`
  zip.file('[Content_Types].xml', `${DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>`)
  zip.file('_rels/.rels', rels([['rId1', 'officeDocument', 'word/document.xml']]))
  zip.file('word/_rels/document.xml.rels', rels([['rId1', 'styles', 'styles.xml'], ['rId2', 'numbering', 'numbering.xml'], ['rId3', 'header', 'header1.xml'], ['rId9', 'hyperlink', 'https://example.com/']]))
  zip.file('word/styles.xml', `${DECLARATION}<w:styles ${W}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style></w:styles>`)
  zip.file('word/numbering.xml', `${DECLARATION}<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`)
  zip.file('word/header1.xml', `${DECLARATION}<w:hdr ${W}><w:p>${run('Tea Co. — private')}</w:p></w:hdr>`)
  zip.file('word/document.xml', `${DECLARATION}<w:document ${W}><w:body>${body}<w:sectPr><w:headerReference w:type="default" r:id="rId3"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720"/></w:sectPr></w:body></w:document>`)
  return zip.generateAsync({ type: 'uint8array' })
}

/** The words of each paragraph of `wordFile`, by number: `null` for one that is more than words. */
export const WORD_WORDS = ['Our plan', 'We sell tea and cake.', 'Green tea', 'Price:\t£4', 'Region', 'Q3', null, 'First line\nsecond line', '', null, null, 'The end.']

