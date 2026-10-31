import { afterEach, describe, expect, it, vi } from 'vitest'

import { deckFile, documentFile, paragraph, placeholder, table } from '../../test/officeFiles'
import { drawnPage } from './drawnPage'
import { readable } from './documentPage'

const answered = (bytes: ArrayBuffer) => vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { status: 200 })))
const asPage = (html: string) => new DOMParser().parseFromString(html, 'text/html')

afterEach(() => vi.unstubAllGlobals())

describe('a deck or a Word document drawn from its bytes', () => {
  it('draws a deck’s slides with the words, bullets and table style they take after, from the file the daemon answers', async () => {
    answered(await deckFile({
      layout: placeholder(2, 'body', '1', ''),
      slides: [
        placeholder(3, 'title', null, paragraph('What we found')) + placeholder(4, null, '1', paragraph('Sales grew') + paragraph('North led', 1)),
        table([['Region', 'Q1'], ['North', '4']], '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}'),
      ],
    }))
    const page = asPage(await drawnPage('/teams/.loomwatch/t/deck-maker/deck.pptx', 'slides', 'deck.pptx', '3'))
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/files/raw?path=%2Fteams%2F.loomwatch%2Ft%2Fdeck-maker%2Fdeck.pptx&v=3', expect.anything())
    expect([...page.querySelectorAll('h2')].map((heading) => heading.textContent)).toEqual(['Slide 1', 'Slide 2'])
    const first = page.querySelectorAll('section')[0]
    expect(first.textContent).toContain('What we found')
    // Its body text keeps the master's bullets, as lists.
    expect([...first.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['Sales grew', 'North led'])
    const header = page.querySelectorAll('section')[1].querySelector('td')!
    expect(header.textContent).toBe('Region')
    expect(header.style.background).toBe('rgb(79, 129, 189)')
  })

  it('draws a Word document’s pages, its fonts falling back alike', async () => {
    answered(await documentFile('Brief', ['We sell tea.', 'Mostly green.']))
    const page = await drawnPage('/teams/.loomwatch/t/writer/brief.docx', 'document', 'brief.docx', '0')
    const doc = asPage(page)
    expect(doc.title).toBe('brief.docx')
    expect(doc.querySelector('section.docx')!.textContent).toBe('BriefWe sell tea.Mostly green.')
    expect(page).toContain("'Calibri', Calibri, Carlito")
    expect(page).not.toContain('<script src')
  })

  it('says why, in the daemon’s words, when the file can’t be had', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'deck.pptx is gone' }), { status: 404 })))
    await expect(drawnPage('/w/deck.pptx', 'slides', 'deck.pptx', '0')).rejects.toThrow('deck.pptx is gone')
  })
})

describe('a Word document made to read on any computer', () => {
  it('follows each font it names with fonts like it, leaving a theme’s font and a named stack as they are', () => {
    expect(readable('<style>.docx p { font-family: Calibri; } h1 { font-family: var(--docx-majorHAnsi-font); }</style>'))
      .toBe("<style>.docx p { font-family: 'Calibri', Calibri, Carlito, 'Helvetica Neue', Arial, sans-serif; } h1 { font-family: var(--docx-majorHAnsi-font); }</style>")
    expect(readable(':root { --docx-minorHAnsi-font: Cambria; }')).toBe(":root { --docx-minorHAnsi-font: 'Cambria', Georgia, 'Times New Roman', serif; }")
    expect(readable('<span style="font-family: Courier New, monospace">x</span>')).toBe('<span style="font-family: Courier New, monospace">x</span>')
  })

  it('gives the words of a paragraph in the default style that style’s look, not only the paragraph', () => {
    expect(readable('.docx p, p.docx_normal span { font-family: Calibri; }'))
      .toBe(".docx p, .docx p span, p.docx_normal span { font-family: 'Calibri', Calibri, Carlito, 'Helvetica Neue', Arial, sans-serif; }")
    // Another style's words are reached already.
    expect(readable('p.docx_heading1 span { color: red; }')).toBe('p.docx_heading1 span { color: red; }')
  })

  it('draws Word’s Symbol and Wingdings bullets as the marks they are', () => {
    expect(readable('p::before { content: ""; font-family: Symbol; } q::before { content: ""; font-family: Wingdings; }'))
      .toBe('p::before { content: "•"; font-family: inherit; } q::before { content: "▪"; font-family: inherit; }')
  })
})
