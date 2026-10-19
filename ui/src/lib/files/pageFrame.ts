import { readFile, rawFileUrl } from './reader'

/**
 * A web page an agent made, shown in the reader (ADR 0077). It runs as it would in a browser — its
 * own scripts and styles, and those it loads from the web — but in a sandbox of its own: a frame
 * with no origin, so it cannot reach LoomWatch's page or the daemon, under a policy that lets it
 * fetch nothing and reach nothing on this computer (`https:` only). A small script LoomWatch adds
 * tells the reader what is marked, so a part of the page can be asked about as any file's can, and
 * shows the parts already asked about.
 */

/** What the page may load: from the web over https, or from itself. Nothing on this computer, no requests of its own, no forms. */
export const PAGE_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https: data: blob:",
  "style-src 'unsafe-inline' https: data:",
  'img-src https: data: blob:',
  'font-src https: data:',
  'media-src https: data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  'worker-src blob:',
].join('; ')

/** The sandbox the frame runs in: scripts, and links that open in a browser, but no origin. */
export const PAGE_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox'

/**
 * The script added to the page. It reports the marked words and where they are, lets go of them on
 * Escape (the key reaches the page, not the reader, once words in it are marked), opens web links
 * outside the reader, and lights the parts asked about (found as the reader finds them: whitespace
 * aside). Written as plain script, not compiled: it runs inside the page.
 */
export const PAGE_BRIDGE = `(function () {
  var send = function (message) { message.lw = 'reader'; parent.postMessage(message, '*'); };
  var down = false, shown = false, timer = 0;
  function report() {
    var selection = document.getSelection();
    var text = selection && selection.rangeCount && !selection.isCollapsed ? String(selection) : '';
    if (!text.trim()) { if (shown) { shown = false; send({ type: 'selection', text: '' }); } return; }
    var box = selection.getRangeAt(0).getBoundingClientRect();
    shown = true;
    send({ type: 'selection', text: text, rect: { top: box.top, bottom: box.bottom, left: box.left, right: box.right } });
  }
  document.addEventListener('pointerdown', function () { down = true; if (shown) { shown = false; send({ type: 'selection', text: '' }); } }, true);
  document.addEventListener('pointerup', function () { down = false; setTimeout(report, 0); }, true);
  document.addEventListener('selectionchange', function () { if (down) return; clearTimeout(timer); timer = setTimeout(report, 120); });
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || !shown) return;
    var selection = document.getSelection();
    if (selection) selection.removeAllRanges();
    shown = false; send({ type: 'selection', text: '' });
  }, true);
  addEventListener('scroll', function () { if (shown) report(); }, true);
  addEventListener('resize', function () { if (shown) report(); });
  document.addEventListener('click', function (event) {
    var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!link || (link.getAttribute('href') || '').charAt(0) === '#') return;
    event.preventDefault();
    if (/^https?:/i.test(link.href)) window.open(link.href, '_blank', 'noopener');
  }, true);
  function index() {
    var skip = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
    var walker = document.createTreeWalker(document.body || document.documentElement, 4, {
      acceptNode: function (node) { return node.parentNode && skip[node.parentNode.nodeName] ? 2 : 1; }
    });
    var page = { chars: '', nodes: [], node: [], offset: [] };
    for (var current = walker.nextNode(); current; current = walker.nextNode()) {
      var at = page.nodes.push(current) - 1, value = current.data;
      for (var i = 0; i < value.length; i++) {
        if (/\\s/.test(value[i])) continue;
        page.chars += value[i]; page.node.push(at); page.offset.push(i);
      }
    }
    return page;
  }
  function find(page, passage) {
    var wanted = String(passage || '').replace(/\\u2026$/, '').replace(/\\s/g, '');
    if (!wanted) return null;
    var start = page.chars.indexOf(wanted);
    if (start < 0 && wanted.length > 400) { wanted = wanted.slice(0, 400); start = page.chars.indexOf(wanted); }
    if (start < 0) return null;
    var end = start + wanted.length - 1, range = document.createRange();
    range.setStart(page.nodes[page.node[start]], page.offset[start]);
    range.setEnd(page.nodes[page.node[end]], page.offset[end] + 1);
    return range;
  }
  function light(name, ranges) {
    var highlight = new Highlight();
    ranges.forEach(function (range) { if (range) highlight.add(range); });
    CSS.highlights.set(name, highlight);
  }
  addEventListener('message', function (event) {
    var data = event.data;
    if (event.source !== parent || !data || data.lw !== 'reader') return;
    if (data.type === 'clear') { var selection = document.getSelection(); if (selection) selection.removeAllRanges(); shown = false; }
    if (data.type === 'marks' && window.CSS && CSS.highlights && typeof Highlight === 'function') {
      var page = index();
      light('lw-read-asked', (data.asked || []).map(function (text) { return find(page, text); }));
      light('lw-read-asking', data.asking ? [find(page, data.asking)] : []);
      light('lw-read-focus', data.focus ? [find(page, data.focus)] : []);
    }
  });
  var style = document.createElement('style');
  style.textContent = '::highlight(lw-read-asked){background-color:rgba(214,168,54,.28)}'
    + '::highlight(lw-read-asking){background-color:rgba(214,168,54,.5)}'
    + '::highlight(lw-read-focus){background-color:rgba(214,168,54,.72)}'
    + '::selection{background-color:rgba(214,168,54,.4)}';
  (document.head || document.documentElement).appendChild(style);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { send({ type: 'ready' }); });
  else send({ type: 'ready' });
})();`

/** A message from the page's script, once checked to be one. */
export type PageMessage =
  | { type: 'selection'; text: string; rect?: { top: number; bottom: number; left: number; right: number } }
  | { type: 'ready' }

export function pageMessage(data: unknown): PageMessage | null {
  if (!data || typeof data !== 'object' || (data as { lw?: unknown }).lw !== 'reader') return null
  const message = data as { type?: unknown; text?: unknown; rect?: unknown }
  if (message.type === 'ready') return { type: 'ready' }
  if (message.type !== 'selection' || typeof message.text !== 'string') return null
  const rect = message.rect as Record<string, unknown> | undefined
  const numbers = rect && ['top', 'bottom', 'left', 'right'].every((key) => typeof rect[key] === 'number' && Number.isFinite(rect[key]))
  return { type: 'selection', text: message.text.slice(0, 100_000), rect: numbers ? (rect as { top: number; bottom: number; left: number; right: number }) : undefined }
}

/** The most of a page's own files (pictures beside it, its stylesheet, its script) taken in. */
const MAX_OWN_FILES = 40

/** A link to a file beside the page: not the web, not data, not a part of the page itself. */
function isBeside(url: string): boolean {
  const value = url.trim()
  return value !== '' && !value.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('//')
}

/** `chart.png` beside `/a/b/page.html` → `/a/b/chart.png`; `..` steps up; a query or fragment is dropped. */
export function besidePath(page: string, url: string): string | null {
  const clean = decodeURIComponentSafe(url.trim().replace(/[?#].*$/, ''))
  if (!clean) return null
  const windows = /^[A-Za-z]:[\\/]/.test(page)
  const separator = windows ? '\\' : '/'
  const parts = page.split(/[\\/]/)
  parts.pop()
  for (const part of clean.split(/[\\/]/)) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length > 1) parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts.join(separator)
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

async function dataUrl(response: Response): Promise<string> {
  const type = response.headers.get('content-type') ?? 'application/octet-stream'
  const bytes = new Uint8Array(await response.arrayBuffer())
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return `data:${type};base64,${btoa(binary)}`
}

/**
 * The page as the frame is given it: the policy first, LoomWatch's script next, and the files it
 * names beside it taken in — pictures as data, its own stylesheet and script as text — since the
 * sandboxed frame cannot ask the daemon for them. A file that is not there is left as written.
 */
export async function pageDocument(html: string, path: string, signal?: AbortSignal): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const head = doc.head ?? doc.documentElement.insertBefore(doc.createElement('head'), doc.body)
  let taken = 0
  const take = () => taken++ < MAX_OWN_FILES
  const jobs: Promise<void>[] = []
  for (const image of Array.from(doc.querySelectorAll<HTMLImageElement | HTMLSourceElement>('img[src], source[src]'))) {
    const src = image.getAttribute('src') ?? ''
    const file = isBeside(src) ? besidePath(path, src) : null
    if (!file || !take()) continue
    jobs.push(fetch(rawFileUrl(file), { signal }).then(async (response) => { if (response.ok) image.setAttribute('src', await dataUrl(response)) }).catch(() => undefined))
  }
  for (const link of Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]'))) {
    const href = link.getAttribute('href') ?? ''
    const file = isBeside(href) ? besidePath(path, href) : null
    if (!file || !take()) continue
    jobs.push(readFile(file, signal).then((read) => {
      const style = doc.createElement('style')
      style.textContent = read.text
      link.replaceWith(style)
    }).catch(() => undefined))
  }
  for (const script of Array.from(doc.querySelectorAll<HTMLScriptElement>('script[src]'))) {
    const src = script.getAttribute('src') ?? ''
    const file = isBeside(src) ? besidePath(path, src) : null
    if (!file || !take()) continue
    jobs.push(readFile(file, signal).then((read) => {
      script.removeAttribute('src')
      // A script's text cannot close the tag it sits in.
      script.textContent = read.text.replace(/<\/script/gi, '<\\/script')
    }).catch(() => undefined))
  }
  await Promise.all(jobs)
  // Anything the page set as its base or its own policy gives way to the reader's.
  doc.querySelectorAll('base, meta[http-equiv="Content-Security-Policy" i]').forEach((node) => node.remove())
  const policy = doc.createElement('meta')
  policy.setAttribute('http-equiv', 'Content-Security-Policy')
  policy.setAttribute('content', PAGE_POLICY)
  const bridge = doc.createElement('script')
  bridge.textContent = PAGE_BRIDGE
  head.prepend(policy, bridge)
  if (!head.querySelector('meta[charset]')) {
    const charset = doc.createElement('meta')
    charset.setAttribute('charset', 'utf-8')
    head.prepend(charset)
  }
  return `<!doctype html>\n${doc.documentElement.outerHTML}`
}
