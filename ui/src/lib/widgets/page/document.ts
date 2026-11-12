import { cleanMarkup, drawInto } from './clean'
import { pageRenderer, workerMain } from './run'
import { PAGE_STYLE } from './style'

/**
 * The document a page is drawn in (ADR 0125): its frame's whole `srcdoc`.
 *
 * The frame has no origin and runs only LoomWatch's renderer (`./run.ts`), under a policy that
 * loads nothing from any address. That is stricter than the reader's frame for pages an agent
 * made as files (`lib/files/pageFrame.ts`), which may load from the web. The agent's markup is
 * cleaned before it is drawn (`./clean.ts`). Its script never runs in this document: it travels
 * as data and runs in a worker the renderer starts, where it can't touch the page or move the
 * frame anywhere.
 */

/** What the frame may do: run scripts, and nothing else. No origin, forms, pop-ups or moving
    the window it is in. */
export const FRAME_SANDBOX = 'allow-scripts'

/** What the frame's document may load: its renderer, by `nonce`; the worker it starts; pictures
    and fonts written into the page; and nothing from any address. */
export function framePolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' blob:`,
    'worker-src blob:',
    'child-src blob:',
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "manifest-src 'none'",
  ].join('; ')
}

/** A token of `bytes` random bytes, for a frame's messages and its renderer's nonce. */
export function randomToken(bytes = 16): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes))
  return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('')
}

/** Data written inside a `<script type="application/json">`: no `<` that could close it, and
    no line separator JavaScript would read as a line break. */
function inertJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</gu, '\\u003c')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029')
}

const attribute = (value: string) => value.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/</gu, '&lt;')

/** LoomWatch's own code as the frame runs it, with no `</script` that would end its element. */
const code = (fn: (...args: never[]) => unknown) => fn.toString().replace(/<\/script/giu, '<\\/script')

/** The frame's document for a page's `html` and `script`. `token` marks its messages; `nonce`
    lets only the renderer run. `theme` is the chat's at the start, so the frame's ground is clear
    before its look arrives: a frame whose scheme isn't the chat's is drawn on an opaque ground. */
export function frameDocument(page: { html?: string; script?: string }, token: string, nonce: string, theme: 'light' | 'dark' = 'light'): string {
  const boot = inertJson({ token, html: page.html ?? '', script: page.script ?? '', worker: code(workerMain) })
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${attribute(framePolicy(nonce))}">`
    + `<meta name="color-scheme" content="${theme}">`
    + '<meta http-equiv="x-dns-prefetch-control" content="off"><meta name="referrer" content="no-referrer">'
    + `<style>${PAGE_STYLE}</style><style id="lw-look"></style></head>`
    + '<body><div id="lw-root"></div>'
    + `<script type="application/json" id="lw-boot">${boot}</script>`
    + `<script nonce="${nonce}">(${code(pageRenderer)})(${code(cleanMarkup)}, ${code(drawInto)})</script>`
    + '</body></html>'
}
