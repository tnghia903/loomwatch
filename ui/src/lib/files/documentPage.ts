import { renderAsync } from 'docx-preview'

import { lookOf, PAPER_LOOK, type PageLook } from './pageLook'
import { escapeHtml, fontStack } from './slidesPage'

/**
 * A Word document drawn inside LoomWatch as a web page of its pages (ADR 0091), so the reader shows
 * it as it shows a page an agent made: its words marked and asked about, any part picked with the
 * Pick switch. `docx-preview` lays it out as Word does: its styles, fonts, tables, pictures, headers
 * and footers, a page where the document breaks one. Its pictures are kept in the page as data, as
 * the reader's sandboxed frame can fetch nothing.
 *
 * A page keeps its width, and the whole document is scaled down to the reader's width by the page's
 * own script when the reader is narrower.
 */
export async function documentPage(bytes: ArrayBuffer, name: string, look: PageLook = PAPER_LOOK): Promise<string> {
  const body = document.createElement('div')
  const styles = document.createElement('div')
  await renderAsync(bytes, body, styles, {
    className: 'docx',
    inWrapper: true,
    breakPages: true,
    ignoreLastRenderedPageBreak: true,
    useBase64URL: true,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    // Comments and tracked changes are how it was written, not what it says.
    renderComments: false,
    renderChanges: false,
    experimental: false,
    debug: false,
  })
  // Nothing in the document runs: it is drawn, not opened.
  for (const script of Array.from(body.querySelectorAll('script'))) script.remove()
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(name)}</title>${readable(styles.innerHTML)}<style>${pageStyle(lookOf(look))}</style></head>`,
    `<body>${readable(body.innerHTML)}<script>${FIT}</script></body></html>`,
  ].join('')
}

/**
 * The drawn document made to read on any computer: each font it names followed by fonts like it,
 * so a heading in Calibri on a Mac without it falls back to a sans and not to Times; and the bullets
 * Word draws from its Symbol and Wingdings fonts, which hold them where no other font does, as the
 * marks they are.
 *
 * And the words of a paragraph in the default style given that style's look: `docx-preview` 0.4.1
 * writes it for `.docx p, p.docx_normal span`, which reaches the paragraph but not its words, so
 * they took the document's default font instead (Cambria, where its Normal style says Calibri).
 */
export function readable(html: string): string {
  return html
    .replace(/\.docx p, (p\.docx_[\w-]+ span)(?=\s*\{)/g, '.docx p, .docx p span, $1')
    .replace(/(font-family:\s*)([^;"'}<>,]+?)(\s*[;"}])/g, (whole, start: string, family: string, end: string) => (family.trim().startsWith('var(') ? whole : `${start}${fontStack(family)}${end}`))
    .replace(/(--docx-[A-Za-z]+-font:\s*)([^;"'}<>,]+?)(\s*[;"}])/g, (_, start: string, family: string, end: string) => `${start}${fontStack(family)}${end}`)
    .replace(/[\uF0A7\uF0A8\uF0B7\uF0D8\uF0FC\uF06E\uF076\uF0E0]/g, (mark) => SYMBOL_MARKS[mark] ?? mark)
    // Those marks drawn in their own font would draw nothing.
    .replace(/font-family:\s*'?(Symbol|Wingdings)'?[^;"}]*/g, 'font-family: inherit')
}

/** Word's bullets kept where Symbol and Wingdings keep them, as their Unicode marks. */
const SYMBOL_MARKS: Record<string, string> = {
  '\uF0B7': '•', '\uF0A7': '▪', '\uF0A8': '◻', '\uF0D8': '➢', '\uF0FC': '✓', '\uF06E': '■', '\uF076': '❖', '\uF0E0': '➔',
}

/** Each page paper on the reader's own ground, as a PDF's pages are. */
const pageStyle = (look: PageLook) => [
  `html{background:${look.ground}}`,
  'body{margin:0}',
  '.docx-wrapper{background:transparent!important;padding:24px!important;align-items:center}',
  '.docx-wrapper>section.docx{border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,.12),0 12px 32px rgba(0,0,0,.14)!important;margin-bottom:40px!important}',
].join('')

/** The pages scaled down to fit the reader's width when it is narrower than they are; never up. */
const FIT = `(function(){function fit(){var wrapper=document.querySelector('.docx-wrapper');if(!wrapper)return;var widest=0;Array.prototype.forEach.call(wrapper.querySelectorAll(':scope>section.docx'),function(page){widest=Math.max(widest,page.offsetWidth);});if(!widest)return;var room=document.documentElement.clientWidth-32;wrapper.style.zoom=String(Math.min(1,Math.max(0.2,room/widest)));}addEventListener('resize',fit);fit();})();`
